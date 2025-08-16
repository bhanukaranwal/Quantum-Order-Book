      [VolatilityClass.MEDIUM]: 1.0,
      [VolatilityClass.HIGH]: 0.7,
      [VolatilityClass.VERY_HIGH]: 0.5,
      [VolatilityClass.EXTREME]: 0.3
    },
    marketCapMultipliers: {
      [MarketCapClass.MEGA]: 1.2,
      [MarketCapClass.LARGE]: 1.0,
      [MarketCapClass.MID]: 0.8,
      [MarketCapClass.SMALL]: 0.6,
      [MarketCapClass.MICRO]: 0.4,
      [MarketCapClass.NANO]: 0.2
    },
    confidenceScaleExponent: 0.5,
    timeOfDayAdjustment: {
      enabled: true,
      peakHourMultiplier: 0.8,
      offHourMultiplier: 1.0,
      weekendMultiplier: 0.7
    },
    concentrationAdjustment: {
      enabled: true,
      thresholds: [
        { level: 0.1, multiplier: 1.0 },
        { level: 0.2, multiplier: 0.9 },
        { level: 0.3, multiplier: 0.8 },
        { level: 0.4, multiplier: 0.6 },
        { level: 0.5, multiplier: 0.4 }
      ]
    }
  };

  constructor(
    logger: Logger,
    volatilityService: VolatilityService,
    accountService: AccountService,
    marketDataService: MarketDataService,
    configService: ConfigService
  ) {
    this.logger = logger;
    this.volatilityService = volatilityService;
    this.accountService = accountService;
    this.marketDataService = marketDataService;
    this.configService = configService;
    
    // Load configuration
    this.loadConfiguration();
    
    // Subscribe to configuration changes
    this.configService.subscribeToChanges('position-sizing', () => {
      this.loadConfiguration();
    });
  }
  
  /**
   * Calculate optimal position size
   */
  public async calculatePositionSize(params: PositionSizingParams): Promise<PositionSizingResult> {
    try {
      this.logger.debug('Calculating adaptive position size', { params });
      
      // Get account details
      const account = await this.accountService.getAccountDetails(params.accountId);
      if (!account) {
        throw new Error(`Account not found: ${params.accountId}`);
      }
      
      // Get current market data
      const marketData = await this.marketDataService.getMarketData(params.symbol);
      if (!marketData) {
        throw new Error(`Market data not found for symbol: ${params.symbol}`);
      }
      
      // Extract base and quote assets from symbol
      const [baseAsset, quoteAsset] = params.symbol.split('-');
      
      // Get current price
      const currentPrice = params.entryPrice || marketData.lastPrice;
      
      // Get account balances
      const quoteBalance = account.balances.find(b => b.asset === quoteAsset)?.free || 0;
      const accountEquity = account.equity;
      
      // Use provided risk percentage or default
      const riskPercentage = params.riskPercentage || this.config.defaultRiskPercentage;
      
      // Use provided stop loss percentage or default
      const stopLossPercentage = params.stopLossPercentage || this.config.defaultStopLossPercentage;
      
      // Use provided max position percentage or default
      const maxPositionPercentage = params.maxPositionPercentage || this.config.defaultMaxPositionPercentage;
      
      // Calculate risk amount (amount willing to lose on this trade)
      const riskAmount = accountEquity * (riskPercentage / 100);
      
      // Calculate stop loss price
      const stopLossPrice = params.positionType === 'long'
        ? currentPrice * (1 - stopLossPercentage / 100)
        : currentPrice * (1 + stopLossPercentage / 100);
      
      // Calculate base position size based on risk per pip
      const priceRisk = Math.abs(currentPrice - stopLossPrice);
      let baseSize = riskAmount / priceRisk;
      
      // Calculate quote size
      let quoteSize = baseSize * currentPrice;
      
      // Calculate max allowed position size based on max percentage
      const maxAllowedQuoteSize = accountEquity * (maxPositionPercentage / 100);
      
      // Ensure position size doesn't exceed max allowed
      if (quoteSize > maxAllowedQuoteSize) {
        quoteSize = maxAllowedQuoteSize;
        baseSize = quoteSize / currentPrice;
      }
      
      // Ensure position size doesn't exceed available balance
      if (quoteSize > quoteBalance) {
        quoteSize = quoteBalance;
        baseSize = quoteSize / currentPrice;
      }
      
      // Apply adjustment factors
      const adjustmentFactors: PositionSizingResult['adjustmentFactors'] = {};
      
      // Volatility adjustment
      if (params.volatilityAdjustment !== false) {
        const volatilityClass = await this.getVolatilityClass(params.symbol);
        const volatilityMultiplier = this.config.volatilityMultipliers[volatilityClass];
        
        baseSize *= volatilityMultiplier;
        quoteSize *= volatilityMultiplier;
        
        adjustmentFactors.volatility = volatilityMultiplier;
      }
      
      // Market cap adjustment
      if (params.marketCapAdjustment !== false) {
        const marketCapClass = await this.getMarketCapClass(params.symbol);
        const marketCapMultiplier = this.config.marketCapMultipliers[marketCapClass];
        
        baseSize *= marketCapMultiplier;
        quoteSize *= marketCapMultiplier;
        
        adjustmentFactors.marketCap = marketCapMultiplier;
      }
      
      // Confidence adjustment
      if (params.confidence !== undefined) {
        const confidenceMultiplier = Math.pow(params.confidence, this.config.confidenceScaleExponent);
        
        baseSize *= confidenceMultiplier;
        quoteSize *= confidenceMultiplier;
        
        adjustmentFactors.confidence = confidenceMultiplier;
      }
      
      // Concentration adjustment
      if (this.config.concentrationAdjustment.enabled) {
        const concentrationMultiplier = await this.calculateConcentrationMultiplier(
          params.accountId,
          params.symbol,
          quoteSize
        );
        
        baseSize *= concentrationMultiplier;
        quoteSize *= concentrationMultiplier;
        
        adjustmentFactors.concentration = concentrationMultiplier;
      }
      
      // Time of day adjustment
      if (this.config.timeOfDayAdjustment.enabled) {
        const timeMultiplier = this.getTimeOfDayMultiplier();
        
        baseSize *= timeMultiplier;
        quoteSize *= timeMultiplier;
        
        adjustmentFactors.timeOfDay = timeMultiplier;
      }
      
      // Round to appropriate precision
      baseSize = this.roundToTickSize(baseSize, marketData.basePrecision);
      quoteSize = this.roundToTickSize(quoteSize, marketData.quotePrecision);
      
      // Calculate effective risk percentage
      const maxLossAmount = baseSize * priceRisk;
      const effectiveRiskPercentage = (maxLossAmount / accountEquity) * 100;
      
      // Calculate implied leverage
      const leverage = quoteSize / (accountEquity * (maxPositionPercentage / 100));
      
      const result: PositionSizingResult = {
        symbol: params.symbol,
        baseSize,
        quoteSize,
        effectiveRiskPercentage,
        stopLossPrice,
        maxLossAmount,
        leverage: Math.min(leverage, this.config.maxLeverage),
        adjustmentFactors
      };
      
      this.logger.debug('Position size calculation result', { result });
      
      return result;
    } catch (error) {
      this.logger.error('Error calculating position size', {
        error,
        params
      });
      throw error;
    }
  }
  
  /**
   * Get volatility classification for a symbol
   */
  private async getVolatilityClass(symbol: string): Promise<VolatilityClass> {
    try {
      // Get volatility metrics
      const volatility = await this.volatilityService.getHistoricalVolatility(symbol, '1d', 30);
      
      // Classify based on volatility level
      if (volatility < 0.01) return VolatilityClass.VERY_LOW;
      if (volatility < 0.02) return VolatilityClass.LOW;
      if (volatility < 0.03) return VolatilityClass.MEDIUM;
      if (volatility < 0.05) return VolatilityClass.HIGH;
      if (volatility < 0.08) return VolatilityClass.VERY_HIGH;
      return VolatilityClass.EXTREME;
    } catch (error) {
      this.logger.error('Error getting volatility class', {
        error,
        symbol
      });
      
      // Default to medium volatility on error
      return VolatilityClass.MEDIUM;
    }
  }
  
  /**
   * Get market cap classification for a symbol
   */
  private async getMarketCapClass(symbol: string): Promise<MarketCapClass> {
    try {
      // Get asset info
      const assetInfo = await this.marketDataService.getAssetInfo(symbol);
      const marketCap = assetInfo?.marketCap || 0;
      
      // Classify based on market cap
      if (marketCap > 200e9) return MarketCapClass.MEGA;     // > $200B
      if (marketCap > 10e9) return MarketCapClass.LARGE;     // $10B-$200B
      if (marketCap > 2e9) return MarketCapClass.MID;        // $2B-$10B
      if (marketCap > 300e6) return MarketCapClass.SMALL;    // $300M-$2B
      if (marketCap > 50e6) return MarketCapClass.MICRO;     // $50M-$300M
      return MarketCapClass.NANO;                            // < $50M
    } catch (error) {
      this.logger.error('Error getting market cap class', {
        error,
        symbol
      });
      
      // Default to mid cap on error
      return MarketCapClass.MID;
    }
  }
  
  /**
   * Calculate concentration multiplier
   */
  private async calculateConcentrationMultiplier(
    accountId: string,
    symbol: string,
    plannedPositionSize: number
  ): Promise<number> {
    try {
      // Get account positions
      const positions = await this.accountService.getAccountPositions(accountId);
      
      // Calculate total portfolio value
      const portfolioValue = positions.reduce(
        (sum, position) => sum + Math.abs(position.notionalValue),
        0
      );
      
      // Calculate current concentration in this asset
      const existingPosition = positions.find(p => p.symbol === symbol);
      const existingValue = existingPosition ? Math.abs(existingPosition.notionalValue) : 0;
      
      // Calculate projected concentration after new position
      const projectedValue = existingValue + plannedPositionSize;
      const projectedConcentration = projectedValue / (portfolioValue + plannedPositionSize);
      
      // Find applicable threshold
      const thresholds = this.config.concentrationAdjustment.thresholds;
      
      for (let i = thresholds.length - 1; i >= 0; i--) {
        if (projectedConcentration >= thresholds[i].level) {
          return thresholds[i].multiplier;
        }
      }
      
      // If no threshold is hit, use default multiplier
      return 1.0;
    } catch (error) {
      this.logger.error('Error calculating concentration multiplier', {
        error,
        accountId,
        symbol
      });
      
      // Default to 1.0 (no adjustment) on error
      return 1.0;
    }
  }
  
  /**
   * Get time of day multiplier based on current market conditions
   */
  private getTimeOfDayMultiplier(): number {
    const now = new Date();
    const utcHour = now.getUTCHours();
    const dayOfWeek = now.getUTCDay(); // 0 = Sunday, 6 = Saturday
    
    // Check if it's a weekend
    if (dayOfWeek === 0 || dayOfWeek === 6) {
      return this.config.timeOfDayAdjustment.weekendMultiplier;
    }
    
    // Check if it's during peak trading hours (assuming 8:00-16:00 UTC for global markets)
    if (utcHour >= 8 && utcHour < 16) {
      return this.config.timeOfDayAdjustment.peakHourMultiplier;
    }
    
    // Otherwise it's off-hours
    return this.config.timeOfDayAdjustment.offHourMultiplier;
  }
  
  /**
   * Round to appropriate tick size
   */
  private roundToTickSize(value: number, precision: number): number {
    const factor = Math.pow(10, precision);
    return Math.floor(value * factor) / factor;
  }
  
  /**
   * Load configuration from config service
   */
  private async loadConfiguration(): Promise<void> {
    try {
      const config = await this.configService.getConfig('position-sizing');
      
      if (config) {
        this.config = {
          ...this.config,
          ...config
        };
        
        this.logger.info('Loaded position sizing configuration');
      }
    } catch (error) {
      this.logger.error('Error loading position sizing configuration', {
        error
      });
    }
  }
}