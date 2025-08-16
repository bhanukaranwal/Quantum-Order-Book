import { Logger } from '../utils/Logger';
import { EventEmitter } from '../events/EventEmitter';
import { MarketDataService } from '../services/MarketDataService';
import { AnalyticsRepository } from '../repositories/AnalyticsRepository';
import { Redis } from 'ioredis';

/**
 * Correlation matrix
 */
interface CorrelationMatrix {
  id: string;
  timestamp: number;
  timeframe: string;
  symbols: string[];
  values: number[][];
  metadata: {
    sampleSize: number;
    startTime: number;
    endTime: number;
    method: string;
  };
}

/**
 * Asset pair correlation
 */
interface AssetCorrelation {
  symbol1: string;
  symbol2: string;
  correlation: number;
  timestamp: number;
  timeframe: string;
  sampleSize: number;
  startTime: number;
  endTime: number;
}

/**
 * Correlation analysis request
 */
interface CorrelationRequest {
  symbols: string[];
  timeframe: string;
  startTime?: number;
  endTime?: number;
  method?: 'pearson' | 'spearman' | 'kendall';
  lookbackPeriods?: number;
}

/**
 * Correlation-based alert
 */
interface CorrelationAlert {
  id: string;
  timestamp: number;
  type: 'CORRELATION_CHANGE' | 'CORRELATION_BREAKDOWN' | 'HIGH_CORRELATION';
  symbol1: string;
  symbol2: string;
  correlation: number;
  previousCorrelation: number;
  change: number;
  timeframe: string;
  severity: 'low' | 'medium' | 'high';
  message: string;
}

/**
 * Correlation engine for multi-asset analysis
 */
export class CorrelationEngine {
  private logger: Logger;
  private eventEmitter: EventEmitter;
  private marketDataService: MarketDataService;
  private analyticsRepository: AnalyticsRepository;
  private redis: Redis;
  
  private correlationCache: Map<string, CorrelationMatrix> = new Map();
  private monitoredPairs: Set<string> = new Set();
  private isRunning: boolean = false;
  private updateInterval: NodeJS.Timeout | null = null;
  private alertThresholds = {
    changeThreshold: 0.3,       // Alert on correlation change of 0.3 or more
    breakdownThreshold: 0.5,    // Alert on correlation breakdown of 0.5 or more
    highCorrelationThreshold: 0.8 // Alert on correlation above 0.8
  };
  
  constructor(
    marketDataService: MarketDataService,
    analyticsRepository: AnalyticsRepository,
    eventEmitter: EventEmitter,
    redis: Redis
  ) {
    this.logger = new Logger('CorrelationEngine');
    this.marketDataService = marketDataService;
    this.analyticsRepository = analyticsRepository;
    this.eventEmitter = eventEmitter;
    this.redis = redis;
  }
  
  /**
   * Start the correlation engine
   */
  public async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('Correlation engine is already running');
      return;
    }
    
    this.isRunning = true;
    this.logger.info('Starting correlation engine');
    
    // Load monitored pairs
    await this.loadMonitoredPairs();
    
    // Load recent correlation matrices
    await this.loadRecentCorrelations();
    
    // Start periodic update
    this.startPeriodicUpdate();
    
    // Subscribe to events
    this.subscribeToEvents();
    
    this.logger.info('Correlation engine started');
  }
  
  /**
   * Stop the correlation engine
   */
  public stop(): void {
    if (!this.isRunning) {
      this.logger.warn('Correlation engine is not running');
      return;
    }
    
    this.isRunning = false;
    this.logger.info('Stopping correlation engine');
    
    // Stop periodic update
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
    
    this.logger.info('Correlation engine stopped');
  }
  
  /**
   * Calculate correlation matrix for a set of symbols
   */
  public async calculateCorrelationMatrix(
    request: CorrelationRequest
  ): Promise<CorrelationMatrix> {
    try {
      const { 
        symbols, 
        timeframe, 
        startTime,
        endTime,
        method = 'pearson',
        lookbackPeriods = 100
      } = request;
      
      if (!symbols || symbols.length < 2) {
        throw new Error('At least two symbols are required');
      }
      
      // Sort symbols to ensure consistent ordering
      const sortedSymbols = [...symbols].sort();
      
      // Create a unique key for caching
      const cacheKey = this.getCorrelationMatrixKey(sortedSymbols, timeframe);
      
      // Check cache first if no specific time range is requested
      if (!startTime && !endTime) {
        const cached = this.correlationCache.get(cacheKey);
        if (cached) {
          return cached;
        }
      }
      
      // Fetch price data for each symbol
      const now = Date.now();
      const actualStartTime = startTime || this.getDefaultStartTime(timeframe, lookbackPeriods);
      const actualEndTime = endTime || now;
      
      const priceData: Record<string, number[]> = {};
      for (const symbol of sortedSymbols) {
        const candles = await this.marketDataService.getCandles(
          symbol,
          timeframe,
          actualStartTime,
          actualEndTime
        );
        
        if (!candles || candles.length < 10) {
          throw new Error(`Insufficient data for ${symbol}`);
        }
        
        // Extract closing prices
        priceData[symbol] = candles.map(candle => candle.close);
      }
      
      // Ensure all price arrays have the same length
      const minLength = Math.min(...Object.values(priceData).map(prices => prices.length));
      for (const symbol of sortedSymbols) {
        priceData[symbol] = priceData[symbol].slice(0, minLength);
      }
      
      // Calculate correlation matrix
      const matrix = this.computeCorrelationMatrix(priceData, sortedSymbols, method);
      
      // Create result object
      const result: CorrelationMatrix = {
        id: `corr_${timeframe}_${Date.now()}`,
        timestamp: now,
        timeframe,
        symbols: sortedSymbols,
        values: matrix,
        metadata: {
          sampleSize: minLength,
          startTime: actualStartTime,
          endTime: actualEndTime,
          method
        }
      };
      
      // Store in cache if no specific time range was requested
      if (!startTime && !endTime) {
        this.correlationCache.set(cacheKey, result);
        
        // Store in repository
        await this.analyticsRepository.saveCorrelationMatrix(result);
      }
      
      return result;
    } catch (error) {
      this.logger.error(`Error calculating correlation matrix: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Get correlation between two assets
   */
  public async getAssetCorrelation(
    symbol1: string,
    symbol2: string,
    timeframe: string,
    lookbackPeriods: number = 100
  ): Promise<AssetCorrelation> {
    try {
      // Ensure consistent symbol ordering
      const [s1, s2] = [symbol1, symbol2].sort();
      
      // Calculate full correlation matrix with these symbols
      const matrix = await this.calculateCorrelationMatrix({
        symbols: [s1, s2],
        timeframe,
        lookbackPeriods
      });
      
      // Extract correlation from matrix
      const idx1 = matrix.symbols.indexOf(s1);
      const idx2 = matrix.symbols.indexOf(s2);
      const correlation = matrix.values[idx1][idx2];
      
      return {
        symbol1: s1,
        symbol2: s2,
        correlation,
        timestamp: matrix.timestamp,
        timeframe: matrix.timeframe,
        sampleSize: matrix.metadata.sampleSize,
        startTime: matrix.metadata.startTime,
        endTime: matrix.metadata.endTime
      };
    } catch (error) {
      this.logger.error(`Error getting asset correlation: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Monitor correlation between two assets
   */
  public async monitorAssetCorrelation(
    symbol1: string,
    symbol2: string,
    timeframes: string[] = ['1h', '1d']
  ): Promise<boolean> {
    try {
      // Ensure consistent symbol ordering
      const [s1, s2] = [symbol1, symbol2].sort();
      
      // Create pair key
      const pairKey = `${s1}:${s2}`;
      
      // Add to monitored pairs
      this.monitoredPairs.add(pairKey);
      
      // Save to repository
      await this.analyticsRepository.saveMonitoredCorrelationPair({
        symbol1: s1,
        symbol2: s2,
        timeframes,
        active: true,
        createdAt: Date.now()
      });
      
      // Calculate initial correlation for baseline
      for (const timeframe of timeframes) {
        await this.getAssetCorrelation(s1, s2, timeframe);
      }
      
      this.logger.info(`Now monitoring correlation between ${s1} and ${s2}`);
      return true;
    } catch (error) {
      this.logger.error(`Error setting up correlation monitoring: ${error.message}`);
      return false;
    }
  }
  
  /**
   * Stop monitoring correlation between two assets
   */
  public async stopMonitoringAssetCorrelation(
    symbol1: string,
    symbol2: string
  ): Promise<boolean> {
    try {
      // Ensure consistent symbol ordering
      const [s1, s2] = [symbol1, symbol2].sort();
      
      // Create pair key
      const pairKey = `${s1}:${s2}`;
      
      // Remove from monitored pairs
      this.monitoredPairs.delete(pairKey);
      
      // Update repository
      await this.analyticsRepository.updateMonitoredCorrelationPair(s1, s2, { active: false });
      
      this.logger.info(`Stopped monitoring correlation between ${s1} and ${s2}`);
      return true;
    } catch (error) {
      this.logger.error(`Error stopping correlation monitoring: ${error.message}`);
      return false;
    }
  }
  
  /**
   * Get correlation matrix from cache or repository
   */
  public async getCorrelationMatrix(
    symbols: string[],
    timeframe: string
  ): Promise<CorrelationMatrix | null> {
    try {
      // Sort symbols to ensure consistent ordering
      const sortedSymbols = [...symbols].sort();
      
      // Create a unique key for caching
      const cacheKey = this.getCorrelationMatrixKey(sortedSymbols, timeframe);
      
      // Check cache first
      const cached = this.correlationCache.get(cacheKey);
      if (cached) {
        return cached;
      }
      
      // Try to load from repository
      const matrix = await this.analyticsRepository.getLatestCorrelationMatrix(sortedSymbols, timeframe);
      
      if (matrix) {
        // Store in cache
        this.correlationCache.set(cacheKey, matrix);
        return matrix;
      }
      
      return null;
    } catch (error) {
      this.logger.error(`Error getting correlation matrix: ${error.message}`);
      return null;
    }
  }
  
  /**
   * Get historical correlation data for a pair of assets
   */
  public async getHistoricalCorrelation(
    symbol1: string,
    symbol2: string,
    timeframe: string,
    startTime: number,
    endTime: number = Date.now()
  ): Promise<AssetCorrelation[]> {
    try {
      // Ensure consistent symbol ordering
      const [s1, s2] = [symbol1, symbol2].sort();
      
      // Get historical correlation matrices
      const matrices = await this.analyticsRepository.getHistoricalCorrelationMatrices(
        [s1, s2],
        timeframe,
        startTime,
        endTime
      );
      
      // Extract correlation for this pair from each matrix
      return matrices.map(matrix => {
        const idx1 = matrix.symbols.indexOf(s1);
        const idx2 = matrix.symbols.indexOf(s2);
        const correlation = matrix.values[idx1][idx2];
        
        return {
          symbol1: s1,
          symbol2: s2,
          correlation,
          timestamp: matrix.timestamp,
          timeframe: matrix.timeframe,
          sampleSize: matrix.metadata.sampleSize,
          startTime: matrix.metadata.startTime,
          endTime: matrix.metadata.endTime
        };
      });
    } catch (error) {
      this.logger.error(`Error getting historical correlation: ${error.message}`);
      return [];
    }
  }
  
  /**
   * Get correlation alerts
   */
  public async getCorrelationAlerts(
    startTime: number,
    endTime: number = Date.now(),
    limit: number = 100
  ): Promise<CorrelationAlert[]> {
    try {
      return await this.analyticsRepository.getCorrelationAlerts(startTime, endTime, limit);
    } catch (error) {
      this.logger.error(`Error getting correlation alerts: ${error.message}`);
      return [];
    }
  }
  
  /**
   * Find highly correlated assets for a given symbol
   */
  public async findCorrelatedAssets(
    symbol: string,
    timeframe: string,
    minimumCorrelation: number = 0.7,
    maxResults: number = 10
  ): Promise<AssetCorrelation[]> {
    try {
      // Get all available symbols
      const allSymbols = await this.marketDataService.getAllSymbols();
      
      // Filter out the input symbol
      const otherSymbols = allSymbols.filter(s => s !== symbol);
      
      // Calculate correlation with each symbol
      const correlations: AssetCorrelation[] = [];
      
      for (const otherSymbol of otherSymbols) {
        try {
          const correlation = await this.getAssetCorrelation(
            symbol,
            otherSymbol,
            timeframe
          );
          
          // Only include if correlation is above threshold
          if (Math.abs(correlation.correlation) >= minimumCorrelation) {
            correlations.push(correlation);
          }
        } catch (error) {
          // Skip if error calculating correlation
          this.logger.debug(`Error calculating correlation for ${symbol}/${otherSymbol}: ${error.message}`);
        }
      }
      
      // Sort by absolute correlation (descending) and limit results
      return correlations
        .sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation))
        .slice(0, maxResults);
    } catch (error) {
      this.logger.error(`Error finding correlated assets: ${error.message}`);
      return [];
    }
  }
  
  /**
   * Find correlation regime changes
   */
  public async findCorrelationRegimeChanges(
    timeframe: string,
    lookbackDays: number = 30,
    changeThreshold: number = 0.3
  ): Promise<Array<{
    symbol1: string;
    symbol2: string;
    oldCorrelation: number;
    newCorrelation: number;
    change: number;
  }>> {
    try {
      // Get all monitored pairs
      const pairKeys = Array.from(this.monitoredPairs);
      const now = Date.now();
      const recentPeriodStart = now - (7 * 24 * 60 * 60 * 1000); // Last 7 days
      const oldPeriodStart = recentPeriodStart - (lookbackDays * 24 * 60 * 60 * 1000);
      
      const results = [];
      
      for (const pairKey of pairKeys) {
        const [symbol1, symbol2] = pairKey.split(':');
        
        // Get recent correlation
        const recentMatrix = await this.calculateCorrelationMatrix({
          symbols: [symbol1, symbol2],
          timeframe,
          startTime: recentPeriodStart,
          endTime: now
        });
        
        // Get older correlation
        const oldMatrix = await this.calculateCorrelationMatrix({
          symbols: [symbol1, symbol2],
          timeframe,
          startTime: oldPeriodStart,
          endTime: recentPeriodStart
        });
        
        // Extract correlations
        const recentCorrelation = recentMatrix.values[0][1];
        const oldCorrelation = oldMatrix.values[0][1];
        
        // Calculate change
        const change = recentCorrelation - oldCorrelation;
        
        // If change is significant, add to results
        if (Math.abs(change) >= changeThreshold) {
          results.push({
            symbol1,
            symbol2,
            oldCorrelation,
            newCorrelation: recentCorrelation,
            change
          });
        }
      }
      
      // Sort by absolute change (descending)
      return results.sort((a, b) => Math.abs(b.change) - Math.abs(a.change));
    } catch (error) {
      this.logger.error(`Error finding correlation regime changes: ${error.message}`);
      return [];
    }
  }
  
  /**
   * Update correlations for all monitored pairs
   */
  private async updateAllCorrelations(): Promise<void> {
    try {
      if (this.monitoredPairs.size === 0) {
        return;
      }
      
      this.logger.info(`Updating correlations for ${this.monitoredPairs.size} pairs`);
      
      const timeframes = ['1h', '4h', '1d'];
      const pairKeys = Array.from(this.monitoredPairs);
      
      for (const pairKey of pairKeys) {
        const [symbol1, symbol2] = pairKey.split(':');
        
        for (const timeframe of timeframes) {
          try {
            // Get previous correlation
            const prevCorrelation = await this.getCorrelationMatrix([symbol1, symbol2], timeframe);
            
            // Calculate new correlation
            const newCorrelation = await this.calculateCorrelationMatrix({
              symbols: [symbol1, symbol2],
              timeframe,
              lookbackPeriods: 100
            });
            
            // Check for alerts if we have previous data
            if (prevCorrelation) {
              await this.checkCorrelationAlerts(
                symbol1,
                symbol2,
                prevCorrelation,
                newCorrelation
              );
            }
          } catch (error) {
            this.logger.error(`Error updating correlation for ${symbol1}/${symbol2} (${timeframe}): ${error.message}`);
          }
        }
      }
      
      this.logger.info('Correlation update complete');
    } catch (error) {
      this.logger.error(`Error in updateAllCorrelations: ${error.message}`);
    }
  }
  
  /**
   * Check for correlation alerts
   */
  private async checkCorrelationAlerts(
    symbol1: string,
    symbol2: string,
    prevMatrix: CorrelationMatrix,
    newMatrix: CorrelationMatrix
  ): Promise<void> {
    try {
      // Extract correlation values
      const idx1Prev = prevMatrix.symbols.indexOf(symbol1);
      const idx2Prev = prevMatrix.symbols.indexOf(symbol2);
      const prevCorrelation = prevMatrix.values[idx1Prev][idx2Prev];
      
      const idx1New = newMatrix.symbols.indexOf(symbol1);
      const idx2New = newMatrix.symbols.indexOf(symbol2);
      const newCorrelation = newMatrix.values[idx1New][idx2New];
      
      // Calculate change
      const change = newCorrelation - prevCorrelation;
      
      // Check for significant change
      if (Math.abs(change) >= this.alertThresholds.changeThreshold) {
        // Create alert
        const alert: CorrelationAlert = {
          id: `corr_alert_${Date.now()}_${symbol1}_${symbol2}`,
          timestamp: Date.now(),
          type: 'CORRELATION_CHANGE',
          symbol1,
          symbol2,
          correlation: newCorrelation,
          previousCorrelation: prevCorrelation,
          change,
          timeframe: newMatrix.timeframe,
          severity: Math.abs(change) >= 0.5 ? 'high' : 'medium',
          message: `Correlation between ${symbol1} and ${symbol2} changed from ${prevCorrelation.toFixed(2)} to ${newCorrelation.toFixed(2)}`
        };
        
        // Store alert
        await this.analyticsRepository.saveCorrelationAlert(alert);
        
        // Emit event
        this.eventEmitter.emit('correlation:alert', alert);
      }
      
      // Check for correlation breakdown (from highly correlated to low correlation)
      if (Math.abs(prevCorrelation) >= this.alertThresholds.breakdownThreshold && 
          Math.abs(newCorrelation) < this.alertThresholds.breakdownThreshold) {
        // Create alert
        const alert: CorrelationAlert = {
          id: `corr_breakdown_${Date.now()}_${symbol1}_${symbol2}`,
          timestamp: Date.now(),
          type: 'CORRELATION_BREAKDOWN',
          symbol1,
          symbol2,
          correlation: newCorrelation,
          previousCorrelation: prevCorrelation,
          change,
          timeframe: newMatrix.timeframe,
          severity: 'high',
          message: `Correlation breakdown between ${symbol1} and ${symbol2}: from ${prevCorrelation.toFixed(2)} to ${newCorrelation.toFixed(2)}`
        };
        
        // Store alert
        await this.analyticsRepository.saveCorrelationAlert(alert);
        
        // Emit event
        this.eventEmitter.emit('correlation:breakdown', alert);
      }
      
      // Check for new high correlation
      if (Math.abs(prevCorrelation) < this.alertThresholds.highCorrelationThreshold && 
          Math.abs(newCorrelation) >= this.alertThresholds.highCorrelationThreshold) {
        // Create alert
        const alert: CorrelationAlert = {
          id: `corr_high_${Date.now()}_${symbol1}_${symbol2}`,
          timestamp: Date.now(),
          type: 'HIGH_CORRELATION',
          symbol1,
          symbol2,
          correlation: newCorrelation,
          previousCorrelation: prevCorrelation,
          change,
          timeframe: newMatrix.timeframe,
          severity: 'medium',
          message: `High correlation detected between ${symbol1} and ${symbol2}: ${newCorrelation.toFixed(2)}`
        };
        
        // Store alert
        await this.analyticsRepository.saveCorrelationAlert(alert);
        
        // Emit event
        this.eventEmitter.emit('correlation:high', alert);
      }
    } catch (error) {
      this.logger.error(`Error checking correlation alerts: ${error.message}`);
    }
  }
  
  /**
   * Compute correlation matrix
   */
  private computeCorrelationMatrix(
    priceData: Record<string, number[]>,
    symbols: string[],
    method: string = 'pearson'
  ): number[][] {
    const n = symbols.length;
    const matrix: number[][] = Array(n).fill(0).map(() => Array(n).fill(0));
    
    // Diagonal elements are always 1 (self-correlation)
    for (let i = 0; i < n; i++) {
      matrix[i][i] = 1;
    }
    
    // Calculate correlation for each pair
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const symbol1 = symbols[i];
        const symbol2 = symbols[j];
        
        const prices1 = priceData[symbol1];
        const prices2 = priceData[symbol2];
        
        let correlation: number;
        
        // Calculate correlation based on method
        switch (method) {
          case 'pearson':
            correlation = this.calculatePearsonCorrelation(prices1, prices2);
            break;
          case 'spearman':
            correlation = this.calculateSpearmanCorrelation(prices1, prices2);
            break;
          case 'kendall':
            correlation = this.calculateKendallCorrelation(prices1, prices2);
            break;
          default:
            correlation = this.calculatePearsonCorrelation(prices1, prices2);
        }
        
        // Correlation matrix is symmetric
        matrix[i][j] = correlation;
        matrix[j][i] = correlation;
      }
    }
    
    return matrix;
  }
  
  /**
   * Calculate Pearson correlation coefficient
   */
  private calculatePearsonCorrelation(x: number[], y: number[]): number {
    const n = Math.min(x.length, y.length);
    
    // Calculate means
    const meanX = x.slice(0, n).reduce((sum, val) => sum + val, 0) / n;
    const meanY = y.slice(0, n).reduce((sum, val) => sum + val, 0) / n;
    
    // Calculate covariance and variances
    let covariance = 0;
    let varianceX = 0;
    let varianceY = 0;
    
    for (let i = 0; i < n; i++) {
      const diffX = x[i] - meanX;
      const diffY = y[i] - meanY;
      
      covariance += diffX * diffY;
      varianceX += diffX * diffX;
      varianceY += diffY * diffY;
    }
    
    // Avoid division by zero
    if (varianceX === 0 || varianceY === 0) {
      return 0;
    }
    
    return covariance / (Math.sqrt(varianceX) * Math.sqrt(varianceY));
  }
  
  /**
   * Calculate Spearman rank correlation
   */
  private calculateSpearmanCorrelation(x: number[], y: number[]): number {
    const n = Math.min(x.length, y.length);
    
    // Convert to ranks
    const xRanks = this.convertToRanks(x.slice(0, n));
    const yRanks = this.convertToRanks(y.slice(0, n));
    
    // Use Pearson on ranks
    return this.calculatePearsonCorrelation(xRanks, yRanks);
  }
  
  /**
   * Calculate Kendall rank correlation
   */
  private calculateKendallCorrelation(x: number[], y: number[]): number {
    const n = Math.min(x.length, y.length);
    let concordant = 0;
    let discordant = 0;
    
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const signX = Math.sign(x[j] - x[i]);
        const signY = Math.sign(y[j] - y[i]);
        
        if (signX === signY) {
          concordant++;
        } else if (signX !== 0 && signY !== 0) {
          discordant++;
        }
      }
    }
    
    const pairs = n * (n - 1) / 2;
    if (pairs === 0) return 0;
    
    return (concordant - discordant) / pairs;
  }
  
  /**
   * Convert array to ranks
   */
  private convertToRanks(array: number[]): number[] {
    // Create array of indices
    const indices = array.map((_, i) => i);
    
    // Sort indices by values
    indices.sort((a, b) => array[a] - array[b]);
    
    // Assign ranks (handling ties)
    const ranks = new Array(array.length).fill(0);
    let currentRank = 0;
    
    for (let i = 0; i < indices.length; i++) {
      if (i > 0 && array[indices[i]] !== array[indices[i - 1]]) {
        currentRank = i;
      }
      
      ranks[indices[i]] = currentRank + 1;
    }
    
    return ranks;
  }
  
  /**
   * Get default start time based on timeframe
   */
  private getDefaultStartTime(timeframe: string, periods: number): number {
    const now = Date.now();
    
    switch (timeframe) {
      case '1m':
        return now - (periods * 60 * 1000);
      case '5m':
        return now - (periods * 5 * 60 * 1000);
      case '15m':
        return now - (periods * 15 * 60 * 1000);
      case '30m':
        return now - (periods * 30 * 60 * 1000);
      case '1h':
        return now - (periods * 60 * 60 * 1000);
      case '4h':
        return now - (periods * 4 * 60 * 60 * 1000);
      case '1d':
        return now - (periods * 24 * 60 * 60 * 1000);
      case '1w':
        return now - (periods * 7 * 24 * 60 * 60 * 1000);
      default:
        return now - (periods * 60 * 60 * 1000); // Default to 1h
    }
  }
  
  /**
   * Generate key for correlation matrix cache
   */
  private getCorrelationMatrixKey(symbols: string[], timeframe: string): string {
    return `corr:${timeframe}:${symbols.join(',')}`;
  }
  
  /**
   * Start periodic update of correlations
   */
  private startPeriodicUpdate(): void {
    // Update correlations every hour
    this.updateInterval = setInterval(async () => {
      try {
        if (!this.isRunning) return;
        
        await this.updateAllCorrelations();
      } catch (error) {
        this.logger.error(`Error in periodic correlation update: ${error.message}`);
      }
    }, 60 * 60 * 1000); // Every hour
    
    // Also trigger an initial update
    setTimeout(async () => {
      try {
        if (this.isRunning) {
          await this.updateAllCorrelations();
        }
      } catch (error) {
        this.logger.error(`Error in initial correlation update: ${error.message}`);
      }
    }, 5000);
  }
  
  /**
   * Load monitored pairs from repository
   */
  private async loadMonitoredPairs(): Promise<void> {
    try {
      const pairs = await this.analyticsRepository.getMonitoredCorrelationPairs();
      
      for (const pair of pairs) {
        if (pair.active) {
          const pairKey = `${pair.symbol1}:${pair.symbol2}`;
          this.monitoredPairs.add(pairKey);
        }
      }
      
      this.logger.info(`Loaded ${this.monitoredPairs.size} monitored correlation pairs`);
    } catch (error) {
      this.logger.error(`Error loading monitored correlation pairs: ${error.message}`);
    }
  }
  
  /**
   * Load recent correlations from repository
   */
  private async loadRecentCorrelations(): Promise<void> {
    try {
      const matrices = await this.analyticsRepository.getRecentCorrelationMatrices(20);
      
      for (const matrix of matrices) {
        const key = this.getCorrelationMatrixKey(matrix.symbols, matrix.timeframe);
        this.correlationCache.set(key, matrix);
      }
      
      this.logger.info(`Loaded ${matrices.length} recent correlation matrices`);
    } catch (error) {
      this.logger.error(`Error loading recent correlations: ${error.message}`);
    }
  }
  
  /**
   * Subscribe to events
   */
  private subscribeToEvents(): void {
    // Subscribe to correlation threshold updates
    this.eventEmitter.on('correlation:thresholds_updated', (data: any) => {
      try {
        const { thresholds } = data;
        this.alertThresholds = {
          ...this.alertThresholds,
          ...thresholds
        };
        
        this.logger.info('Updated correlation alert thresholds');
      } catch (error) {
        this.logger.error(`Error handling correlation threshold update: ${error.message}`);
      }
    });
    
    // Subscribe to new symbol pair monitoring requests
    this.eventEmitter.on('correlation:monitor_pair', async (data: any) => {
      try {
        const { symbol1, symbol2, timeframes } = data;
        await this.monitorAssetCorrelation(symbol1, symbol2, timeframes);
      } catch (error) {
        this.logger.error(`Error handling correlation monitor request: ${error.message}`);
      }
    });
  }
}