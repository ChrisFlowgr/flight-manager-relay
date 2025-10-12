import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import { DescentCalculatorSettings, DescentCalculations, SpeedMode, Wind, AccuracyLevel, WeatherData, WeatherProvider, LiveWeatherSettings as LiveWeatherSettingsType } from '../types';
import { getISAValues, getDensityRatio, getSpeedOfSound } from '../utils/isaTable';
import { 
  convertSpeed, 
  convertPressure, 
  roundTo,
  AVIATION_CONSTANTS,
  KNOTS_TO_FPM,
  celsiusToKelvin,
  kelvinToCelsius
} from '../utils/units';
import { convertWindSpeedToKnots } from '../utils/weather';
// Define the AppThunk type locally to avoid import conflicts
import { ThunkAction, Action } from '@reduxjs/toolkit';
import { RootState } from '..';

// Define AppThunk type
export type AppThunk<ReturnType = void> = ThunkAction<
  ReturnType,
  RootState,
  unknown,
  Action<string>
>;

const { 
  GAMMA, 
  R, 
  HIGH_ALTITUDE_THRESHOLD,
  TROPOPAUSE_ALTITUDE 
} = AVIATION_CONSTANTS;

const SEA_LEVEL_TEMPERATURE_K = 288.15; // ISA sea level temperature
const SEA_LEVEL_PRESSURE_PA = 101325;   // ISA sea level pressure
const PROBE_RECOVERY_FACTOR = 0.98;     // Typical adiabatic recovery factor for modern probes

// Utility functions for calculations
export const toRadians = (degrees: number): number => degrees * Math.PI / 180;

/**
 * Convert calibrated airspeed (CAS) in knots to the equivalent sea-level impact pressure (qc0) in Pascals.
 * Uses the subsonic isentropic pitot-static relation.
 */
export const casToQc0 = (CAS_kts: number): number => {
  const CAS_ms = CAS_kts / 1.94384; // Convert knots to m/s
  const a0 = Math.sqrt(GAMMA * R * SEA_LEVEL_TEMPERATURE_K); // Speed of sound at ISA sea level
  const term = 1 + (CAS_ms * CAS_ms) / (5 * a0 * a0);
  return SEA_LEVEL_PRESSURE_PA * (Math.pow(term, 3.5) - 1);
};

/**
 * Derive Mach number from the ratio of impact pressure to static pressure (qc/p).
 */
export const machFromQcOverP = (qcOverP: number): number => {
  const pow = Math.pow(1 + qcOverP, (GAMMA - 1) / GAMMA);
  return Math.sqrt((2 / (GAMMA - 1)) * (pow - 1));
};

/**
 * Calculates Static Air Temperature (SAT) from Total Air Temperature (TAT) and Mach number
 * Uses the standard adiabatic recovery formula
 * @param TAT - Total Air Temperature in Celsius
 * @param mach - Mach number
 * @returns Static Air Temperature in Celsius
 */
export const calculateSAT = (
  TAT: number,
  mach: number,
  recoveryFactor: number = PROBE_RECOVERY_FACTOR
): number => {
  if (typeof TAT !== 'number' || typeof mach !== 'number') {
    throw new Error('Invalid inputs for SAT calculation');
  }

  const TAT_K = celsiusToKelvin(TAT);
  const compression = 1 + recoveryFactor * ((GAMMA - 1) / 2) * Math.pow(mach, 2);
  const SAT_K = TAT_K / compression;
  return roundTo(kelvinToCelsius(SAT_K), 1);
};

/**
 * Calculates Total Air Temperature (TAT) from Static Air Temperature (SAT) and Mach number
 * Uses the standard adiabatic recovery formula: TAT = SAT × (1 + 0.2M²)
 * @param SAT - Static Air Temperature in Celsius
 * @param TAS - True Airspeed in knots
 * @param altitude - Current altitude in feet (diagnostic logging only)
 * @returns Total Air Temperature in Celsius
 */
export const calculateTAT = (
  SAT: number,
  TAS: number,
  altitude: number,
  recoveryFactor: number = PROBE_RECOVERY_FACTOR
): number => {
  console.log(`===== DEBUG TAT: calculateTAT called with SAT=${SAT}°C, TAS=${TAS}kts, altitude=${altitude}ft, r=${recoveryFactor} =====`);
  
  if (TAS <= 0) {
    console.log(`===== DEBUG TAT: TAS is zero or negative (${TAS}), returning SAT=${SAT}°C =====`);
    return SAT;
  }
  
  try {
    const speedOfSound = calculateSpeedOfSound(SAT);
    const TAS_ms = TAS / 1.94384;
    const machNumber = TAS_ms / speedOfSound;
    const SAT_K = celsiusToKelvin(SAT);
    const compression = 1 + recoveryFactor * ((GAMMA - 1) / 2) * Math.pow(machNumber, 2);
    const TAT_K = SAT_K * compression;
    const TAT = kelvinToCelsius(TAT_K);
    
    if (TAT < SAT && machNumber > 0.1) {
      console.error(`===== ERROR TAT: Calculated TAT (${TAT}°C) is lower than SAT (${SAT}°C) at Mach ${machNumber}! This is physically impossible. =====`);
      return SAT;
    }
    
    console.log(`===== DEBUG TAT: Temperature rise due to compression: ${TAT - SAT}°C =====`);
    return roundTo(TAT, 1);
  } catch (error) {
    console.error('Error calculating TAT:', error);
    return SAT;
  }
};
;
;

/**
 * Calculates TAS from Mach number and altitude
 * @throws Error if inputs are invalid
 */
export const calculateTASFromMach = (mach: number, altitude: number): number => {
  if (typeof mach !== 'number' || typeof altitude !== 'number') {
    throw new Error('Invalid inputs for TAS calculation');
  }
  // Get speed of sound in m/s from ISA table
  const speedOfSound = getSpeedOfSound(altitude);
  // Multiply Mach by speed of sound to get TAS in m/s, then convert to knots
  return mach * speedOfSound * 1.94384; // Convert m/s to knots
};

/**
 * Calculates TAS from IAS using the pressure-ratio method
 * This method directly uses the pressure difference to calculate Mach and TAS
 * @param IAS - Indicated airspeed in knots
 * @param altitude - Altitude in feet
 * @param actualTemp - Actual temperature in Celsius
 * @returns True airspeed in knots
 */
export const calculateTASAlt = (IAS: number, altitude: number, actualTemp: number): number => {
  console.log(`===== DEBUG: calculateTASAlt called with IAS=${IAS}, altitude=${altitude}, actualTemp=${actualTemp} =====`);

  if (IAS <= 0) {
    console.log('===== DEBUG: IAS <= 0, returning 0 TAS =====');
    return 0;
  }

  // ISA static pressure at altitude
  const isaValues = getISAValues(altitude);
  const p = isaValues.pressure; // Pa
  console.log(`===== DEBUG: ISA values at ${altitude}ft: temp=${isaValues.tempC}°C, pressure=${p}Pa =====`);

  // Treat IAS as CAS (unless instrument/position error modelling is added later)
  const CAS = IAS;

  // 1) Sea-level impact pressure from CAS
  const qc0 = casToQc0(CAS);
  console.log(`===== DEBUG: q_c0 from CAS=${CAS}kts -> ${qc0} Pa =====`);

  // 2) Form qc/p at altitude (using ISA static pressure)
  const qc_over_p = qc0 / p;
  console.log(`===== DEBUG: qc/p at altitude = ${qc_over_p} =====`);

  // 3) Mach from qc/p
  const M = machFromQcOverP(qc_over_p);
  console.log(`===== DEBUG: Mach from qc/p = ${M} =====`);

  // 4) Speed of sound from actual SAT and resulting TAS
  const a = calculateSpeedOfSound(actualTemp); // m/s
  const TAS = M * a * 1.94384; // knots
  console.log(`===== DEBUG: TAS = ${TAS} kts (a=${a} m/s) =====`);

  // Diagnostics: compare ISA-based sound speed
  const aISA = calculateSpeedOfSound(isaValues.tempC);
  console.log(`===== DEBUG: a(ISA ${isaValues.tempC}°C)=${aISA} m/s; Δa=${a - aISA} m/s =====`);

  return TAS;
};
;

/**
 * Calculates TAS from IAS considering altitude, temperature, and compressibility
 * Uses iterative method for accurate compressibility correction
 * @param IAS - Indicated airspeed in knots
 * @param altitude - Altitude in feet
 * @param actualTemp - Actual temperature in Celsius
 * @returns True airspeed in knots
 */
export const calculateTAS = (IAS: number, altitude: number, actualTemp: number): number => {
  if (typeof IAS !== 'number' || typeof altitude !== 'number' || typeof actualTemp !== 'number') {
    throw new Error('Invalid inputs for TAS calculation');
  }
  if (IAS <= 0) {
    return 0;
  }

  try {
    return roundTo(calculateTASAlt(IAS, altitude, actualTemp), 1);
  } catch (error) {
    console.error('calculateTAS fallback error:', error);
    return 0;
  }
};
;

/**
 * Calculates wind component based on wind speed, direction and aircraft heading
 */
export const calculateWindComponent = (
  windSpeed: number,
  windDirection: number,
  aircraftHeading: number | undefined
): number => {
  if (typeof windSpeed !== 'number' || isNaN(windSpeed)) {
    console.warn('Invalid windSpeed in calculateWindComponent, using 0');
    windSpeed = 0;
  }

  if (typeof windDirection !== 'number' || isNaN(windDirection)) {
    console.warn('Invalid windDirection in calculateWindComponent, using 0');
    windDirection = 0;
  }

  const heading = (typeof aircraftHeading === 'number' && !isNaN(aircraftHeading))
    ? aircraftHeading
    : 0;

  const dir = ((Math.round(windDirection) % 360) + 360) % 360;
  const hdg = ((Math.round(heading) % 360) + 360) % 360;
  const relative = ((dir - hdg + 540) % 360) - 180; // [-180, 180)

  return windSpeed * Math.cos(toRadians(relative));
};
;

/**
 * Calculates vertical speed from ground speed and descent angle
 * @throws Error if inputs are invalid
 */
const calculateVerticalSpeed = (groundSpeed: number, descentAngle: number): number => {
  if (typeof groundSpeed !== 'number' || typeof descentAngle !== 'number') {
    throw new Error('Invalid inputs for vertical speed calculation');
  }
  
  if (groundSpeed <= 0) {
    throw new Error('Ground speed must be greater than zero');
  }
  
  if (descentAngle <= 0) {
    throw new Error('Descent angle must be greater than zero');
  }
  
  // Calculate raw vertical speed
  const rawVs = groundSpeed * Math.tan(toRadians(descentAngle)) * KNOTS_TO_FPM;
  
  if (rawVs <= 0) {
    throw new Error('Vertical speed cannot be zero or negative');
  }
  
  // Round to nearest 50 feet
  return Math.round(rawVs / 50) * 50;
};

/**
 * Calculates time and distance for descent
 * @throws Error if inputs are invalid
 */
const calculateTimeAndDistance = (
  altitudeDiff: number,
  groundSpeed: number,
  verticalSpeed: number
): { time: number; distance: number } => {
  if (typeof altitudeDiff !== 'number' || typeof groundSpeed !== 'number' || typeof verticalSpeed !== 'number') {
    throw new Error('Invalid inputs for time and distance calculation');
  }
  if (verticalSpeed === 0) {
    throw new Error('Vertical speed cannot be zero');
  }
  
  const time = Math.abs(altitudeDiff / verticalSpeed);
  const distance = (groundSpeed / 60) * time;
  
  return { time, distance };
};

/**
 * Determines calculation accuracy based on available inputs
 */
const determineAccuracy = (settings: DescentCalculatorSettings): AccuracyLevel => {
  let accuracy: AccuracyLevel = "Medium";
  
  try {
    if (settings.speedMode === "TAS" || settings.speedMode === "MACH") {
      accuracy = "High";
    } else if (settings.speedMode === "IAS" && settings.SAT !== undefined) {
      accuracy = "High";
    }
    
    if (settings.windEnabled && settings.wind && settings.aircraftHeading !== undefined) {
      accuracy = "High";
    }
    
    // Check if we're using actual temperature data
    if (settings.SAT !== undefined || settings.TAT !== undefined) {
      accuracy = "High";
    }
    
    // Validate altitude range
    if (settings.altitudeStart < -2000 || settings.altitudeStart > 50000 ||
        settings.altitudeTarget < -2000 || settings.altitudeTarget > 50000) {
      accuracy = "Low";
    }
  } catch (error) {
    accuracy = "Low";
  }
  
  return accuracy;
};

export const calculateSpeedOfSound = (tempC: number): number => {
  console.log(`===== DEBUG: calculateSpeedOfSound called with temperature: ${tempC}°C =====`);
  
  try {
    // Add validation for extreme temperatures
    if (typeof tempC !== 'number' || isNaN(tempC)) {
      console.error(`===== ERROR: Invalid temperature value: ${tempC}. Using standard ISA sea level value. =====`);
      return 340.3; // Standard speed of sound at ISA sea level
    }
    
    const minTemp = -90; // Minimum realistic atmospheric temperature
    const maxTemp = 100; // Maximum realistic atmospheric temperature
    
    // Clamp to realistic values
    if (tempC < minTemp) {
      console.log(`===== WARNING: Temperature ${tempC}°C is too low for accurate speed of sound calculation. Clamping to ${minTemp}°C. =====`);
      tempC = minTemp;
    } else if (tempC > maxTemp) {
      console.log(`===== WARNING: Temperature ${tempC}°C is too high for accurate speed of sound calculation. Clamping to ${maxTemp}°C. =====`);
      tempC = maxTemp;
    }
    
    // Speed of sound = sqrt(gamma * R * T)
    // where gamma = 1.4, R = 287.05 J/(kg·K), T = temperature in Kelvin
    const tempK = tempC + 273.15; // Convert to Kelvin
    
    // Extra validation for Kelvin temperature (must be positive)
    if (tempK <= 0) {
      console.error(`===== ERROR: Temperature ${tempC}°C converts to ${tempK}K, which is invalid. Using minimum valid temperature. =====`);
      return Math.sqrt(GAMMA * R * 1); // Use minimum valid Kelvin temp (1K) to avoid NaN
    }
    
    const speedOfSound = Math.sqrt(GAMMA * R * tempK); // m/s
    console.log(`===== DEBUG: Speed of sound at ${tempC}°C (${tempK}K) = ${speedOfSound}m/s (${speedOfSound * 1.94384}kts) =====`);
    
    return speedOfSound;
  } catch (error) {
    console.error('Error calculating speed of sound:', error);
    return 340.3; // Default to standard sea level value if calculation fails
  }
};

// Add this interface definition near the other interfaces:
export interface DescentWarnings {
  extremeTemperature?: boolean;
  tempBelowStandard?: boolean;
  tempAboveStandard?: boolean;
  excessiveHeadwind?: boolean;
}

const createFallbackCalculations = (
  overrides: Partial<DescentCalculations> = {}
): DescentCalculations => ({
  verticalSpeed: 0,
  descentTime: 0,
  descentDistance: 0,
  adjustedSpeed: 0,
  accuracy: "Low",
  descentLoss: 0,
  timerActive: false,
  timerStartTime: undefined,
  ...overrides,
});

const performCalculations = (settings: DescentCalculatorSettings): DescentCalculations => {
  try {
    console.log(`===== DEBUG: performCalculations called with settings =====`);
    
    // Validate required settings
    if (settings.altitudeStart === undefined || 
        settings.altitudeTarget === undefined || 
        settings.descentAngle === undefined || 
        settings.speed === undefined ||
        settings.speedMode === undefined) {
      console.warn('DescentCalculator: Missing required settings, returning fallback calculations.');
      return createFallbackCalculations();
    }
    
    // Calculate altitude difference
    const altitudeDiff = settings.altitudeStart - settings.altitudeTarget;
    
    if (!Number.isFinite(altitudeDiff) || altitudeDiff <= 0) {
      console.warn(`DescentCalculator: Invalid altitude difference (start=${settings.altitudeStart}, target=${settings.altitudeTarget}).`);
      return createFallbackCalculations({
        descentLoss: Math.max(0, altitudeDiff || 0),
        adjustedSpeed: Math.max(0, Math.round(settings.speed)),
      });
    }

    if (!Number.isFinite(settings.descentAngle) || settings.descentAngle <= 0) {
      console.warn(`DescentCalculator: Invalid descent angle ${settings.descentAngle}.`);
      return createFallbackCalculations({
        descentLoss: altitudeDiff,
        adjustedSpeed: Math.max(0, Math.round(settings.speed)),
      });
    }

    if (!Number.isFinite(settings.speed) || settings.speed < 0) {
      console.warn(`DescentCalculator: Invalid speed input ${settings.speed}.`);
      return createFallbackCalculations({
        descentLoss: altitudeDiff,
      });
    }

    // Validate altitude is reasonable
    if (settings.altitudeStart < 0) {
      console.error(`===== ERROR: Negative starting altitude (${settings.altitudeStart}ft) detected. This may cause incorrect temperature calculations. =====`);
    }
    
    if (settings.altitudeStart > 60000) {
      console.error(`===== ERROR: Extremely high starting altitude (${settings.altitudeStart}ft) detected. This may cause incorrect temperature calculations. =====`);
    }

    const deviceAltitude = settings.weatherData?.altitude;
    if (settings.altitudeSource === 'device' && deviceAltitude !== undefined) {
      console.log(`===== DEBUG ISA CALCULATION: Weather data reported at device altitude ${deviceAltitude}ft. Using this altitude for surface deviation context while keeping flight calculations at ${settings.altitudeStart}ft =====`);
    } else {
      console.log(`===== DEBUG ISA CALCULATION: Using planned starting altitude (${settings.altitudeStart}ft) for ISA context =====`);
    }

    // Determine if we're at high altitude
    const isHighAltitude = settings.altitudeStart > HIGH_ALTITUDE_THRESHOLD;
    
    // Get ISA values for flight and (if available) device altitudes
    const flightISAValues = getISAValues(settings.altitudeStart);
    console.log(`===== DEBUG ISA CALCULATION: Flight-level ISA values: tempC=${flightISAValues.tempC}°C, tempK=${flightISAValues.tempK}K, pressure=${flightISAValues.pressure}Pa =====`);
    const deviceISAValues = deviceAltitude !== undefined ? getISAValues(deviceAltitude) : undefined;
    if (deviceISAValues) {
      console.log(`===== DEBUG ISA CALCULATION: Device-level ISA values: tempC=${deviceISAValues.tempC}°C, tempK=${deviceISAValues.tempK}K, pressure=${deviceISAValues.pressure}Pa =====`);
    }
    const ISATemp = flightISAValues.tempC;
    console.log(`===== DEBUG ISA CALCULATION: Final ISA temperature used for flight calculations: ${ISATemp}°C =====`);
    
    // Initialize variables with default values
    let actualTemp: number = ISATemp; // Default to ISA temperature (flight-level SAT)
    let ISADeviation: number = 0;
    let TAS: number = 0;
    let machNumber: number | undefined;
    let GS: number | undefined;
    let calculatedTAT: number | undefined;
    let effectiveSpeed: number = settings.speed; // Default to input speed
    
    // Initialize warnings and fallback helper after defaults are defined
    const warnings: DescentWarnings = {};

    const buildFallback = (reason: string, overrides: Partial<DescentCalculations> = {}) => {
      console.warn(`DescentCalculator fallback triggered: ${reason}`);
      const safeSpeed = Number.isFinite(effectiveSpeed) ? effectiveSpeed : 0;
      const mergedWarnings = Object.keys(warnings).length
        ? { ...warnings, ...(overrides.warnings || {}) }
        : overrides.warnings;
      return createFallbackCalculations({
        descentLoss: altitudeDiff > 0 ? altitudeDiff : 0,
        adjustedSpeed: Math.max(0, Math.round(safeSpeed)),
        ...overrides,
        warnings: mergedWarnings,
      });
    };
    
    // Handle temperature calculation based on input method
    if (settings.liveWeather?.enabled && settings.weatherData) {
      console.log(`===== DEBUG: Live weather enabled, processing weather data =====`);
      
      // Important: Get altitude of weather data
      const weatherAltitude = settings.weatherData.altitude || 0;
      const weatherTemp = settings.weatherData.temperature;
      
      console.log(`===== DEBUG: Weather data altitude: ${weatherAltitude}ft, device altitude source: ${settings.altitudeSource} =====`);
      
      // Handle temperature based on altitude source
      if (settings.altitudeSource === 'device' && Math.abs(weatherAltitude - settings.altitudeStart) > 1000) {
        // Using device GPS altitude but planning a flight at a different altitude
        // We need to use the weather temp at device altitude but calculate TAT based on flight altitude
        
        console.log(`===== DEBUG: Using device GPS altitude (${weatherAltitude}ft) but planning flight at ${settings.altitudeStart}ft =====`);
        console.log(`===== DEBUG: Weather temp at device altitude: ${weatherTemp}°C =====`);
        
        // For TAS and most calculations, we'll use the temperature at flight altitude
        // Get ISA temp at flight altitude
        const flightISATemp = flightISAValues.tempC;
        
        // Calculate estimated temperature at flight altitude using standard lapse rate
        const standardLapseRate = 1.98; // °C per 1000ft
        let estimatedFlightTemp: number;
        
        if (settings.altitudeStart <= TROPOPAUSE_ALTITUDE) {
          // Apply standard lapse rate up to tropopause
          const altDiff = (settings.altitudeStart - weatherAltitude) / 1000;
          const tempDiff = altDiff * standardLapseRate;
          estimatedFlightTemp = weatherTemp - tempDiff;
        } else if (weatherAltitude < TROPOPAUSE_ALTITUDE) {
          // Weather is below tropopause but flight is above
          // First calculate to tropopause
          const toTropopauseDiff = (TROPOPAUSE_ALTITUDE - weatherAltitude) / 1000;
          const tempAtTropopause = weatherTemp - (toTropopauseDiff * standardLapseRate);
          // Above tropopause temperature remains constant at -56.5°C
          estimatedFlightTemp = -56.5;
        } else {
          // Both weather and flight are above tropopause
          estimatedFlightTemp = -56.5;
        }
        
        console.log(`===== DEBUG: Estimated temperature at flight altitude: ${estimatedFlightTemp}°C =====`);
        
        // IMPORTANT: Calculate the ISA deviation at the DEVICE's current altitude, not the flight altitude
        // This gives an accurate representation of the current weather conditions
        const deviceISATemp = deviceISAValues?.tempC ?? getISAValues(weatherAltitude).tempC;
        const deviceISADeviation = weatherTemp - deviceISATemp;
        console.log(`===== DEBUG: Calculated ISA deviation at device altitude: ${deviceISADeviation}°C (Weather: ${weatherTemp}°C, ISA at ${weatherAltitude}ft: ${deviceISATemp}°C) =====`);
        
        // Use the estimated flight temperature for actual calculations
        actualTemp = estimatedFlightTemp;
        ISADeviation = actualTemp - flightISATemp;
        
        // Store the actual device temperature as outsideTemp for display
        settings.outsideTemp = weatherTemp;
        
        // IMPORTANT: Store both temperatures for use in different calculations
        settings.deviceTemp = weatherTemp; // Actual measured ground temperature
        settings.flightLevelTemp = estimatedFlightTemp; // Estimated flight level temperature
        
        console.log(`===== DEBUG TEMP TRACKING: Set deviceTemp=${settings.deviceTemp}°C and flightLevelTemp=${settings.flightLevelTemp}°C =====`);
      } else {
        // Normal weather handling - either using starting altitude source
        // or device altitude that's close to flight altitude
        
        // Check if weather data has altitude that matches starting altitude
        if (settings.weatherData.altitude !== undefined && 
            Math.abs(settings.weatherData.altitude - settings.altitudeStart) < 1000) {
          // We have altitude-specific weather data that matches our starting altitude
          // Use the temperature directly instead of applying lapse rate calculations
          actualTemp = settings.weatherData.temperature;
          ISADeviation = actualTemp - ISATemp;
          console.log(`Using altitude-specific weather data: ${actualTemp}°C at ${settings.weatherData.altitude}ft`);
        } else if (settings.altitudeStart <= TROPOPAUSE_ALTITUDE) {
          // Apply standard lapse rate for temperatures below tropopause
          const groundTemp = settings.weatherData.temperature;
          const groundDeviation = groundTemp - 15; // Deviation from ISA at sea level
          
          // Calculate temp at altitude using standard lapse rate
          const altDiff = (settings.altitudeStart - (settings.weatherData.altitude || 0)) / 1000;
          const tempDiff = altDiff * 1.98; // Standard lapse rate °C/1000ft
          actualTemp = groundTemp - tempDiff;
          ISADeviation = actualTemp - ISATemp;
          console.log(`===== DEBUG: Calculated temp from ground using lapse rate: ${actualTemp}°C (ISA: ${ISATemp}°C) =====`);
          
          // Store the actual device temperature as outsideTemp for display
          settings.outsideTemp = settings.weatherData.temperature;
        } else {
          // Above tropopause, temperature remains constant at -56.5°C plus deviation
          const groundTemp = settings.weatherData.temperature;
          const groundDeviation = groundTemp - 15; // Deviation from ISA at sea level
          actualTemp = -56.5 + groundDeviation;
          ISADeviation = actualTemp - ISATemp;
        }
        
        // Store the ground temperature
        settings.outsideTemp = settings.weatherData.temperature;
      }
      
      settings.ISADeviation = ISADeviation;

      // After determining actualTemp:
      if (actualTemp < -50) {
        warnings.extremeTemperature = true;
        warnings.tempBelowStandard = true;
        console.log(`===== WARNING: Using very low temperature (${actualTemp}°C) which may affect calculation accuracy =====`);
      } else if (actualTemp > 50) {
        warnings.extremeTemperature = true;
        warnings.tempAboveStandard = true;
        console.log(`===== WARNING: Using very high temperature (${actualTemp}°C) which may affect calculation accuracy =====`);
      }
    } else {
      // Weather is disabled - allow manual SAT entry or ISA-based fallback
      console.log(`===== DEBUG: Weather disabled, using manual/ISA-based calculations =====`);
      
      const manualSAT = typeof settings.SAT === 'number' && !Number.isNaN(settings.SAT)
        ? settings.SAT
        : undefined;
      
      if (manualSAT !== undefined) {
        actualTemp = manualSAT;
        ISADeviation = manualSAT - ISATemp;
        console.log(`===== DEBUG: Manual SAT provided (${manualSAT}°C); computed ISA deviation ${ISADeviation}°C =====`);
      } else {
        ISADeviation = settings.ISADeviation ?? 0;
        actualTemp = ISATemp + ISADeviation;
        console.log(`===== DEBUG: Using ISA temperature (${ISATemp}°C) with deviation ${ISADeviation}°C to derive SAT ${actualTemp}°C =====`);
      }
      
      settings.SAT = actualTemp;
      settings.ISADeviation = ISADeviation;
      settings.outsideTemp = undefined; // Clear any outdated outside temp
    }
    
    // Store the final ISA deviation in settings
    // settings.ISADeviation = ISADeviation; <- removed to prevent loop

    // Persist the computed flight-level SAT for downstream consumers/UI
    settings.flightLevelTemp = actualTemp;

    const flightSAT = actualTemp;
    
    // Convert speed based on mode using enhanced calculations
    let machFromTAS: number | undefined;

    if (settings.speedMode === "IAS") {
      // Always calculate TAS from IAS using the pressure-ratio method
      TAS = calculateTASAlt(settings.speed, settings.altitudeStart, flightSAT);
      effectiveSpeed = TAS;

      if (Number.isFinite(TAS) && Number.isFinite(flightSAT)) {
        machFromTAS = (TAS / 1.94384) / calculateSpeedOfSound(flightSAT);
        calculatedTAT = calculateTAT(flightSAT, TAS, settings.altitudeStart, PROBE_RECOVERY_FACTOR);
      }
      
      // If at high altitude, use the same method to calculate Mach number

    } else if (settings.speedMode === "MACH") {
      machNumber = settings.speed;

      const speedOfSoundMS = calculateSpeedOfSound(flightSAT);
      console.log(`===== DEBUG MACH MODE: Using flight-level SAT ${flightSAT}°C to calculate speed of sound: ${speedOfSoundMS}m/s =====`);

      TAS = machNumber * speedOfSoundMS * 1.94384;
      console.log(`===== DEBUG MACH MODE: Calculated TAS using actual temperature: ${TAS}kts =====`);

      effectiveSpeed = TAS;
      machFromTAS = machNumber;

      if (Number.isFinite(TAS) && Number.isFinite(flightSAT)) {
        console.log(`===== DEBUG TAT: Using flight level temperature (${flightSAT}°C) for TAT calculation =====`);
        calculatedTAT = calculateTAT(flightSAT, TAS, settings.altitudeStart, PROBE_RECOVERY_FACTOR);
      }
} else if (settings.speedMode === "TAS") {
      TAS = settings.speed;
      effectiveSpeed = TAS;

      if (Number.isFinite(TAS) && Number.isFinite(flightSAT)) {
        console.log(`===== DEBUG TAT: Using flight level temperature (${flightSAT}°C) for TAT calculation =====`);
        calculatedTAT = calculateTAT(flightSAT, TAS, settings.altitudeStart, PROBE_RECOVERY_FACTOR);
        machFromTAS = (TAS / 1.94384) / calculateSpeedOfSound(flightSAT);
      }

      const speedOfSound = calculateSpeedOfSound(flightSAT);
      machNumber = (TAS / 1.94384) / speedOfSound;
    }

      
      // Calculate Mach number
      const speedOfSound = calculateSpeedOfSound(flightSAT);
      machNumber = (TAS / 1.94384) / speedOfSound;
    }
    
    if (machFromTAS !== undefined) {
      machNumber = machFromTAS;
    }

    // Apply wind correction if enabled
    let windComponent: number | undefined;
    if (settings.windEnabled && settings.wind && settings.aircraftHeading !== undefined) {
      // Calculate wind component
      windComponent = calculateWindComponent(
        settings.wind.speed,
        settings.wind.direction,
        settings.aircraftHeading
      );
      const rawGroundSpeed = TAS - windComponent;
      const MIN_GROUND_SPEED = 1; // Prevent divide-by-zero while keeping calculations realistic

      if (rawGroundSpeed <= 0) {
        warnings.excessiveHeadwind = true;
      }

      const adjustedGroundSpeed = Math.max(MIN_GROUND_SPEED, rawGroundSpeed);
      GS = adjustedGroundSpeed;
      effectiveSpeed = adjustedGroundSpeed;
    }
    
    if (!Number.isFinite(effectiveSpeed) || effectiveSpeed <= 0) {
      return buildFallback('Effective ground speed is invalid', {
        adjustedSpeed: 0,
      });
    }

    let verticalSpeed: number;
    try {
      verticalSpeed = calculateVerticalSpeed(effectiveSpeed, settings.descentAngle);
    } catch (error) {
      return buildFallback(`Vertical speed calculation failed: ${(error as Error).message}`);
    }
    
    let time: number;
    let distance: number;
    try {
      const results = calculateTimeAndDistance(
        altitudeDiff,
        effectiveSpeed,
        verticalSpeed
      );
      time = results.time;
      distance = results.distance;
    } catch (error) {
      return buildFallback(`Time/distance calculation failed: ${(error as Error).message}`, {
        adjustedSpeed: Math.round(effectiveSpeed),
      });
    }
    
    // Determine accuracy level based on inputs and calculations
    const accuracy = determineAccuracy(settings);
    
    const result = {
      verticalSpeed,
      descentTime: time,
      descentDistance: distance,
      adjustedSpeed: Math.round(effectiveSpeed),
      accuracy,
      descentLoss: altitudeDiff,
      timerActive: false,
      timerStartTime: undefined,
      TAS: Math.round(TAS),
      GS: windComponent !== undefined ? Math.round(GS ?? TAS) : undefined,
      machNumber: machNumber !== undefined ? Math.round(machNumber * 1000) / 1000 : undefined,
      windComponent: windComponent !== undefined ? Math.round(windComponent) : undefined,
      ISATemp: Math.round(ISATemp * 10) / 10,
      actualTemp: Math.round(actualTemp * 10) / 10,
      calculatedTAT: calculatedTAT ? Math.round(calculatedTAT * 10) / 10 : undefined,
      warnings: Object.keys(warnings).length ? warnings : undefined,
    };
    
    console.log(`===== DEBUG FINAL VALUES: SAT=${actualTemp}°C, TAT=${calculatedTAT}°C, device altitude=${settings.weatherData?.altitude || 'N/A'}ft, flight altitude=${settings.altitudeStart}ft =====`);
    console.log(`===== DEBUG FINAL VALUES: deviceTemp=${settings.deviceTemp || 'N/A'}°C, returned actualTemp=${result.actualTemp}°C, returned TAT=${result.calculatedTAT}°C =====`);
    
    return result;
  } catch (error) {
    console.error('Error in performCalculations:', error);
    return createFallbackCalculations();
  }
};

export const DEFAULT_DESCENT_CALCULATOR_SETTINGS: DescentCalculatorSettings = {
  descentAngle: 3.0,
  altitudeStart: 10000,
  altitudeTarget: 0,
  speed: 250,
  speedMode: "TAS",
  advancedMode: false,
  windEnabled: false,
  wind: {
    direction: 0,
    speed: 0
  },
  liveWeather: {
    enabled: false,
    autoRefresh: true,
    refreshInterval: 5,
    lastUpdate: 0,
    preferredSources: ['NOMAD', 'OpenWeather', 'OpenMeteo'], // Default preferred sources in order
    useAltitudeData: true, // Whether to use altitude-specific weather data
    altitudeSource: 'device' // Default to device altitude
  }
};

export interface DescentCalculatorState {
  settings: DescentCalculatorSettings;
  calculations: DescentCalculations;
}

const initialState: DescentCalculatorState = {
  settings: DEFAULT_DESCENT_CALCULATOR_SETTINGS,
  calculations: {
    verticalSpeed: 0,
    descentTime: 0,
    descentDistance: 0,
    adjustedSpeed: 0,
    accuracy: "Medium",
    descentLoss: 0,
    timerActive: false,
    timerStartTime: undefined
  }
};

export const descentCalculatorSlice = createSlice({
  name: 'descentCalculator',
  initialState,
  reducers: {
    updateSettings: (state, action: PayloadAction<Partial<DescentCalculatorSettings>>) => {
      state.settings = {
        ...state.settings,
        ...action.payload
      };
      state.calculations = performCalculations(state.settings);
    },
    toggleAdvancedMode: (state) => {
      state.settings.advancedMode = !state.settings.advancedMode;
      if (!state.settings.advancedMode) {
        // Reset advanced settings when disabling advanced mode
        state.settings.windEnabled = false;
        state.settings.wind = undefined;
        state.settings.outsideTemp = undefined;
      }
      state.calculations = performCalculations(state.settings);
    },
    toggleWindEnabled: (state) => {
      state.settings.windEnabled = !state.settings.windEnabled;
      // Don't clear wind data when disabling, so it's preserved when re-enabling
      // if (!state.settings.windEnabled) {
      //   state.settings.wind = undefined;
      // }
      
      // If enabling wind but no wind data exists, create default wind
      if (state.settings.windEnabled && !state.settings.wind) {
        state.settings.wind = {
          direction: 0,
          speed: 0
        };
      }
      
      state.calculations = performCalculations(state.settings);
    },
    updateWind: (state, action: PayloadAction<Wind>) => {
      // If updating wind data, ensure wind is enabled
      if (!state.settings.windEnabled) {
        state.settings.windEnabled = true;
      }
      
      state.settings.wind = action.payload;
      state.calculations = performCalculations(state.settings);
    },
    setSpeedMode: (state, action: PayloadAction<SpeedMode>) => {
      const currentSpeed = state.settings.speed;
      const currentMode = state.settings.speedMode;
      const newMode = action.payload;
      let newSpeed = currentSpeed;

      // When switching to IAS mode
      if (newMode === 'IAS') {
        newSpeed = Math.max(250, currentSpeed); // Ensure minimum IAS of 250 knots
      }
      // When switching to MACH mode
      else if (newMode === 'MACH') {
        newSpeed = 0.65; // Default to typical descent Mach number
      }
      // For TAS or GS modes
      else {
        newSpeed = Math.max(250, currentSpeed); // Ensure minimum speed of 250 knots
      }

      state.settings.speedMode = newMode;
      state.settings.speed = newSpeed;
      
      // Recalculate all values including TAT
      state.calculations = performCalculations({
        ...state.settings,
        speedMode: newMode,
        speed: newSpeed
      });
    },
    resetCalculator: (state) => {
      state.settings = DEFAULT_DESCENT_CALCULATOR_SETTINGS;
      state.calculations = performCalculations(DEFAULT_DESCENT_CALCULATOR_SETTINGS);
    },
    startTimer: (state) => {
      state.calculations.timerActive = true;
      state.calculations.timerStartTime = Date.now();
    },
    stopTimer: (state) => {
      state.calculations.timerActive = false;
      state.calculations.timerStartTime = undefined;
    },
    resetTimer: (state) => {
      state.calculations.timerActive = false;
      state.calculations.timerStartTime = undefined;
    },
    toggleLiveWeather: (state) => {
      if (!state.settings.liveWeather) {
        state.settings.liveWeather = DEFAULT_DESCENT_CALCULATOR_SETTINGS.liveWeather;
      }
      if (state.settings.liveWeather) {
        state.settings.liveWeather.enabled = !state.settings.liveWeather.enabled;
        
        // Clear weather data and wind settings when disabling
        if (!state.settings.liveWeather.enabled) {
          state.settings.weatherData = undefined;
          state.settings.windEnabled = false;
          state.settings.wind = undefined;
        }
      }
      
      // Recalculate with updated settings
      state.calculations = performCalculations(state.settings);
    },
    updateWeatherData: (state, action: PayloadAction<WeatherData>) => {
      // Store quality and source info along with weather data
      state.settings.weatherData = action.payload;
      
      // Update last update timestamp
      if (state.settings.liveWeather) {
        state.settings.liveWeather.lastUpdate = action.payload.timestamp;
      }
      
      // If weather includes wind data, always update the wind settings
      if (action.payload.windSpeed !== undefined && 
          action.payload.windDirection !== undefined) {
        
        // Always convert the wind speed to knots and round values for consistency
        const windSpeedKnots = Math.round(convertWindSpeedToKnots(action.payload.windSpeed));
        const windDirection = ((Math.round(action.payload.windDirection) % 360) + 360) % 360;
        
        // If live weather is enabled, update the wind settings
        if (state.settings.liveWeather?.enabled) {
          state.settings.windEnabled = true;
          state.settings.wind = {
            speed: windSpeedKnots,
            direction: windDirection
          };
        }
      }
      
      // Recalculate with new weather data
      state.calculations = performCalculations(state.settings);
    },
    setAutoRefresh: (state, action: PayloadAction<boolean>) => {
      if (state.settings.liveWeather) {
        state.settings.liveWeather.autoRefresh = action.payload;
      }
    },
    setRefreshInterval: (state, action: PayloadAction<number>) => {
      if (state.settings.liveWeather) {
        state.settings.liveWeather.refreshInterval = action.payload;
      }
    },
    setPreferredWeatherSources: (state, action: PayloadAction<WeatherProvider[]>) => {
      if (state.settings.liveWeather) {
        state.settings.liveWeather.preferredSources = action.payload;
      }
    },
    setUseAltitudeData: (state, action: PayloadAction<boolean>) => {
      if (state.settings.liveWeather) {
        state.settings.liveWeather.useAltitudeData = action.payload;
      }
    },
    setAltitudeSource: (state, action: PayloadAction<'device' | 'startingAltitude'>) => {
      if (state.settings.liveWeather) {
        state.settings.liveWeather.altitudeSource = action.payload;
      }
      
      // CRITICAL FIX: Also update the main altitudeSource property
      // This ensures consistency between the two properties
      state.settings.altitudeSource = action.payload;
      
      // Recalculate with the new altitude source
      console.log(`===== DEBUG: Altitude source changed to ${action.payload} =====`);
      state.calculations = performCalculations(state.settings);
    },
  }
});

export const {
  updateSettings: updateDescentCalculatorSettings,
  toggleAdvancedMode,
  toggleWindEnabled,
  updateWind: updateDescentCalculatorWind,
  setSpeedMode,
  resetCalculator,
  startTimer,
  stopTimer,
  resetTimer,
  toggleLiveWeather,
  updateWeatherData,
  setAutoRefresh,
  setRefreshInterval,
  setPreferredWeatherSources,
  setUseAltitudeData,
  setAltitudeSource,
} = descentCalculatorSlice.actions;

// Custom action creator for ISA deviation to prevent update loops
export const setISADeviation = (deviation: number | undefined): AppThunk => 
  (dispatch, getState) => {
    const { descentCalculator } = getState();
    const { settings } = descentCalculator;
    
    // Don't do anything if live weather is enabled
    if (settings.liveWeather?.enabled) {
      console.log('===== DEBUG: Live weather is enabled, ISA deviation will be calculated from weather data =====');
      return;
    }
    
    console.log(`===== DEBUG: Setting ISA deviation to ${deviation !== undefined ? deviation : 'undefined'} =====`);
    
    // Update just the ISA deviation without triggering unnecessary recalculations
    dispatch(updateDescentCalculatorSettings({
      ISADeviation: deviation,
    }));
    
    // Calculate the resulting SAT once
    if (deviation !== undefined && settings.altitudeStart !== undefined) {
      // Always use the planned flight altitude for ISA comparison
      const isaTemp = getISAValues(settings.altitudeStart).tempC;
      
      // Calculate new SAT
      const calculatedSAT = isaTemp + deviation;
      console.log(`===== DEBUG: Calculated SAT from ISA deviation: ${calculatedSAT}°C (ISA: ${isaTemp}°C + deviation: ${deviation}°C) =====`);
      
      // Update SAT without updating ISA deviation again
      dispatch(updateDescentCalculatorSettings({
        SAT: calculatedSAT,
      }));
    }
  };

// Calculate custom ISA deviation for manual temperature entry
const setTemperature = (state: DescentCalculatorState, action: PayloadAction<number | undefined>) => {
  state.settings.SAT = action.payload;
  
  if (action.payload !== undefined) {
    // Always compare against ISA at the planned flight altitude
    const ISATemp = getISAValues(state.settings.altitudeStart).tempC;
    
    // Calculate ISA deviation from manually entered temperature
    state.settings.ISADeviation = action.payload - ISATemp;
  } else {
    state.settings.ISADeviation = undefined;
  }
  
  // Recalculate with new temperature
  state.calculations = performCalculations(state.settings);
};

export default descentCalculatorSlice.reducer; 
