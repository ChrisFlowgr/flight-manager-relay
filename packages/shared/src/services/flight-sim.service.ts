/**
 * Flight Simulator Service
 * 
 * Responsible for communication with Microsoft Flight Simulator via the SimConnect API
 * Uses a Node.js server as middleware for SimConnect communication
 */

import { SimWeatherData } from '../types';

export interface FlightRouteData {
  flightId?: string;
  departure?: string;
  destination?: string;
  altitude?: number;
  heading?: number;
  speed?: number;
  groundSpeed?: number;
  tas?: number;
  mach?: number;
  position?: {
    latitude?: number;
    longitude?: number;
  };
  weather?: SimWeatherData | null;
  isConnected: boolean;
  autopilot?: {
    apMaster?: boolean;
    flightDirector?: boolean;
    headingHold?: boolean;
    nav?: boolean;
    altitudeHold?: boolean;
    verticalSpeedHold?: boolean;
    flightLevelChange?: boolean;
    approachHold?: boolean;
  };
}

// Connection status enum
export enum ConnectionStatus {
  IDLE = 'idle',
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  ERROR = 'error',
}

export enum ConnectionMethod {
  SIMCONNECT = 'simconnect',
  WASM = 'wasm'
}

export interface ConnectionConfig {
  method: ConnectionMethod;
  endpoint: string;
}

/**
 * Flight Simulator Service class
 */
class FlightSimService {
  private static instance: FlightSimService;
  private connectionStatus: ConnectionStatus = ConnectionStatus.IDLE;
  private connectionError: string | null = null;
  private connectionMethod: ConnectionMethod = ConnectionMethod.SIMCONNECT;
  private simulatorEndpoint: string;
  
  // Get a reasonable default endpoint based on environment (mobile vs web)
  private getDefaultEndpoint(): string {
    // Default to localhost for initial connection attempts
    return 'http://localhost:8080';
  }
  
  // Private constructor for singleton pattern
  private constructor() {
    this.simulatorEndpoint = this.getDefaultEndpoint();
    console.log('[FlightSimService] Initialized with endpoint:', this.simulatorEndpoint);
  }
  
  /**
   * Get singleton instance
   */
  public static getInstance(): FlightSimService {
    if (!FlightSimService.instance) {
      FlightSimService.instance = new FlightSimService();
    }
    return FlightSimService.instance;
  }
  
  /**
   * Initialize the service
   * Sets up any required configuration for the service
   */
  public async initialize(): Promise<void> {
    console.log('[FlightSimService] Initializing...');
    // Load saved connection settings if available
    try {
      // Cross-platform storage approach
      let savedConfig: ConnectionConfig | null = null;
      
      // Try to load from localStorage (Web)
      if (typeof localStorage !== 'undefined') {
        const savedSettings = localStorage.getItem('flightSimConnectionConfig');
        if (savedSettings) {
          savedConfig = JSON.parse(savedSettings) as ConnectionConfig;
        }
      } 
      // Otherwise check if we have previously set values
      else if (this.connectionMethod && this.simulatorEndpoint) {
        savedConfig = {
          method: this.connectionMethod,
          endpoint: this.simulatorEndpoint
        };
      }
      
      // Apply saved config if available
      if (savedConfig) {
        this.connectionMethod = savedConfig.method;
        this.simulatorEndpoint = savedConfig.endpoint;
        console.log('[FlightSimService] Using connection config:', savedConfig);
      }
    } catch (e) {
      console.error('[FlightSimService] Error loading saved connection settings:', e);
      // Continue with defaults if there's an error
    }
    
    // Reset connection status at initialization
    this.resetConnectionStatus();
  }
  
  /**
   * Set connection configuration
   * This allows setting different connection methods and endpoints
   */
  public setConnectionConfig(config: ConnectionConfig): void {
    console.log('[FlightSimService] Setting connection config:', config);
    this.connectionMethod = config.method;
    this.simulatorEndpoint = config.endpoint;
    
    // Save configuration for future use
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('flightSimConnectionConfig', JSON.stringify(config));
      }
    } catch (e) {
      console.error('[FlightSimService] Error saving connection settings:', e);
    }
  }
  
  /**
   * Get connection configuration
   */
  public getConnectionConfig(): ConnectionConfig {
    return {
      method: this.connectionMethod,
      endpoint: this.simulatorEndpoint
    };
  }
  
  /**
   * Set simulator endpoint URL
   * This allows connecting to different SimConnect server instances
   */
  public setSimulatorEndpoint(url: string): void {
    console.log('[FlightSimService] Setting simulator endpoint:', url);
    this.simulatorEndpoint = url;
    
    // Update saved config
    const config = this.getConnectionConfig();
    config.endpoint = url;
    this.setConnectionConfig(config);
  }
  
  /**
   * Get current endpoint URL
   */
  public getSimulatorEndpoint(): string {
    return this.simulatorEndpoint;
  }
  
  /**
   * Get current connection status
   */
  public getConnectionStatus(): ConnectionStatus {
    return this.connectionStatus;
  }
  
  /**
   * Get connection error message
   */
  public getConnectionError(): string | null {
    return this.connectionError;
  }
  
  /**
   * Test connection to Microsoft Flight Simulator
   * Attempts to connect and retrieve basic flight data
   */
  public async testConnection(): Promise<FlightRouteData> {
    this.connectionStatus = ConnectionStatus.CONNECTING;
    this.connectionError = null;

    console.log(`[FlightSimService] Testing connection to ${this.simulatorEndpoint} using ${this.connectionMethod} method`);

    try {
      let endpoint = this.simulatorEndpoint;
      let apiPath = '/api/';
      
      // Make sure the endpoint doesn't end with a slash
      if (endpoint.endsWith('/')) {
        endpoint = endpoint.slice(0, -1);
      }
      
      // The full API endpoint URL
      const apiEndpoint = `${endpoint}${apiPath}`;
      console.log(`[FlightSimService] Using API endpoint: ${apiEndpoint}`);
      
      // Make fetch options without using AbortSignal.timeout which isn't available in React Native
      const fetchOptions: RequestInit = {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        }
      };
      
      // Create a timeout promise to race against the fetch
      const timeoutPromise = new Promise<Response>((_, reject) => {
        setTimeout(() => reject(new Error('Connection timed out after 10 seconds')), 10000);
      });
      
      // Check the server status with timeout
      console.log(`[FlightSimService] Fetching status from: ${apiEndpoint}status`);
      
      const response = await Promise.race([
        fetch(`${apiEndpoint}status`, fetchOptions),
        timeoutPromise
      ]) as Response;
      
      if (!response.ok) {
        throw new Error(`Server responded with status: ${response.status}`);
      }
      
      const statusData = await response.json();
      console.log('[FlightSimService] Status response:', statusData);
      
      // For WASM bridge, check different status properties
      if (this.connectionMethod === ConnectionMethod.WASM) {
        // WASM bridge has different status structure
        if (statusData.wasmStatus !== 'connected' && !statusData.bridgeStatus) {
          throw new Error('Server is running but not connected to Flight Simulator');
        }
      } else {
        // SimConnect - check traditional properties
        if (!statusData.fsConnected && !statusData.connected && !statusData.success) {
          throw new Error('Server is running but not connected to Flight Simulator');
        }
      }

      // If status check passes, get flight data
      // Use the proper endpoint path based on connection method
      const flightDataPath = this.connectionMethod === ConnectionMethod.WASM 
        ? 'flight-data'  // WASM bridge uses kebab-case
        : 'flightdata';  // SimConnect server uses camelCase
        
      console.log(`[FlightSimService] Fetching flight data from: ${apiEndpoint}${flightDataPath}`);
      
      // Fetch flight data with timeout
      const flightDataResponse = await Promise.race([
        fetch(`${apiEndpoint}${flightDataPath}`, fetchOptions),
        timeoutPromise
      ]) as Response;
      
      if (!flightDataResponse.ok) {
        throw new Error(`Server responded with status: ${flightDataResponse.status}`);
      }
      
      const flightData = await flightDataResponse.json();
      console.log('[FlightSimService] Flight data response:', flightData);

      this.connectionStatus = ConnectionStatus.CONNECTED;
      
      // Extract flight data
      const routeData: FlightRouteData = {
        isConnected: true
      };
      
      // Extract position and route data
      if (this.connectionMethod === ConnectionMethod.WASM) {
        // WASM module sends data in a different format
        const data = flightData.data;
        
        if (data && data.position) {
          routeData.altitude = data.position.altitude;
          routeData.position = {
            latitude: data.position.latitude,
            longitude: data.position.longitude
          };
        }
        
        if (data && data.parameters) {
          routeData.heading = data.parameters.heading;
          routeData.speed = data.parameters.ground_speed;
          routeData.groundSpeed = data.parameters.ground_speed;
          routeData.tas = data.parameters.true_airspeed ?? data.parameters.ground_speed;
          routeData.mach = data.parameters.mach;
        }
        
        if (data && data.flight_plan) {
          routeData.departure = data.flight_plan.departure;
          routeData.destination = data.flight_plan.destination;
        }

        if (data && data.weather) {
          routeData.weather = data.weather;
        }
      } else {
        // SimConnect format
        const data = flightData.data;
        
        if (data) {
          routeData.departure = data.departure;
          routeData.destination = data.destination;
          routeData.altitude = data.altitude;
          routeData.heading = data.heading;
          routeData.speed = data.speed;
          routeData.groundSpeed = data.groundSpeed ?? data.speed;
          routeData.tas = data.tas ?? data.speed;
          routeData.mach = data.mach;
          routeData.position = data.position;
          routeData.weather = data.weather ?? null;
        }
      }
      
      return routeData;
    } catch (error) {
      console.error('[FlightSimService] Connection test failed:', error);
      this.connectionStatus = ConnectionStatus.ERROR;
      this.connectionError = error instanceof Error ? error.message : String(error);
      
      return {
        isConnected: false
      };
    }
  }
  
  /**
   * Reset connection status
   */
  public resetConnectionStatus(): void {
    this.connectionStatus = ConnectionStatus.IDLE;
    this.connectionError = null;
  }
}

// Export singleton instance
export const flightSimService = FlightSimService.getInstance(); 
