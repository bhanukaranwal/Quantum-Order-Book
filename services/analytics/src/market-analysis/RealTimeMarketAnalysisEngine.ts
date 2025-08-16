        bestMatch = { key, score };
      }
    }
    
    if (!bestMatch) return null;
    
    // Extract price and side from the key
    const [priceStr, side] = bestMatch.key.split('_');
    const price = parseFloat(priceStr);
    const confidence = Math.min(bestMatch.score, 1);
    
    return { price, side, confidence };
  }
  
  /**
   * Detect liquidity sweep pattern
   */
  private detectLiquiditySweep(trades: any[], analysis: MarketStructureAnalysis): boolean {
    // A liquidity sweep typically involves a quick price movement followed by reversal
    if (trades.length < 50) return false;
    
    // Get price movement
    const recentTrades = trades.slice(0, 50);
    const prices = recentTrades.map(t => t.price);
    const maxPrice = Math.max(...prices);
    const minPrice = Math.min(...prices);
    const range = maxPrice - minPrice;
    
    // Need significant range for a sweep
    if (range / minPrice < 0.005) return false;
    
    // Check for quick movement and reversal
    const firstPrice = recentTrades[recentTrades.length - 1].price;
    const midPrice = recentTrades[Math.floor(recentTrades.length / 2)].price;
    const lastPrice = recentTrades[0].price;
    
    // For upward sweep: price goes up then back down
    const upwardSweep = firstPrice < midPrice && lastPrice < midPrice && 
                         midPrice - firstPrice > 0.6 * range;
                         
    // For downward sweep: price goes down then back up
    const downwardSweep = firstPrice > midPrice && lastPrice > midPrice && 
                          firstPrice - midPrice > 0.6 * range;
    
    // Check if the sweep happened with higher than normal volume
    const volumes = recentTrades.map(t => t.quantity);
    const avgVolume = volumes.reduce((sum, v) => sum + v, 0) / volumes.length;
    const sweepVolume = volumes.slice(0, Math.floor(volumes.length / 2)).reduce((sum, v) => sum + v, 0);
    
    const highVolume = sweepVolume > avgVolume * recentTrades.length * 0.3;
    
    return (upwardSweep || downwardSweep) && highVolume;
  }
  
  /**
   * Detect stopping volume pattern
   */
  private detectStoppingVolume(trades: any[], analysis: MarketStructureAnalysis): boolean {
    if (trades.length < 100) return false;
    
    // Get recent price trend
    const trend = analysis.priceAction.recentTrend;
    if (trend === 'neutral') return false;
    
    // Get recent trades
    const recentTrades = trades.slice(0, 100);
    
    // Calculate average volume
    const volumes = recentTrades.map(t => t.quantity);
    const avgVolume = volumes.reduce((sum, v) => sum + v, 0) / volumes.length;
    
    // Calculate volume at current price level
    const currentPrice = recentTrades[0].price;
    const priceThreshold = currentPrice * 0.001; // 0.1% threshold
    
    const tradesAtCurrentPrice = recentTrades.filter(t => 
      Math.abs(t.price - currentPrice) < priceThreshold
    );
    
    if (tradesAtCurrentPrice.length < 5) return false;
    
    const volumeAtCurrentPrice = tradesAtCurrentPrice.reduce((sum, t) => sum + t.quantity, 0);
    
    // Stopping volume typically has 3x or more volume than average
    const highVolume = volumeAtCurrentPrice > avgVolume * tradesAtCurrentPrice.length * 3;
    
    // Check if price has stabilized after the high volume
    const pricesAfterVolume = recentTrades
      .filter(t => t.timestamp > tradesAtCurrentPrice[0].timestamp)
      .map(t => t.price);
      
    const priceStable = pricesAfterVolume.length > 0 && 
                         Math.max(...pricesAfterVolume) - Math.min(...pricesAfterVolume) < priceThreshold * 5;
    
    return highVolume && priceStable;
  }
  
  /**
   * Detect market regime
   */
  private async detectMarketRegime(venue: string, symbol: string): Promise<{ regime: MarketRegime, since: number }> {
    try {
      // Get historical data
      const candles = await this.marketDataService.getCandles(
        venue, 
        symbol, 
        '1h', 
        100 // 100 hours of data
      );
      
      if (!candles || candles.length < 50) {
        throw new Error('Insufficient historical data');
      }
      
      // Calculate price direction
      const prices = candles.map(c => c.close);
      const trendDirection = this.calculateTrendDirection(prices);
      
      // Calculate volatility
      const returns = [];
      for (let i = 1; i < prices.length; i++) {
        returns.push((prices[i] - prices[i-1]) / prices[i-1]);
      }
      
      const volatility = this.calculateVolatility(returns);
      
      // Calculate volume trend
      const volumes = candles.map(c => c.volume);
      const volumeTrend = this.calculateVolumeTrend(volumes);
      
      // Detect regime
      let regime: MarketRegime;
      
      // High volatility regimes
      if (volatility > this.config.regimeDetectionParams.volatilityThreshold) {
        if (trendDirection > this.config.regimeDetectionParams.trendStrengthThreshold) {
          regime = MarketRegime.TRENDING_UP;
        } else if (trendDirection < -this.config.regimeDetectionParams.trendStrengthThreshold) {
          regime = MarketRegime.TRENDING_DOWN;
        } else {
          regime = MarketRegime.VOLATILE;
        }
      } 
      // Low volatility regimes
      else if (volatility < this.config.regimeDetectionParams.volatilityThreshold / 2) {
        if (volumeTrend > 0.5) {
          regime = MarketRegime.ACCUMULATION;
        } else if (volumeTrend < -0.5) {
          regime = MarketRegime.DISTRIBUTION;
        } else {
          regime = MarketRegime.LOW_VOLATILITY;
        }
      } 
      // Medium volatility regimes
      else {
        if (trendDirection > this.config.regimeDetectionParams.trendStrengthThreshold / 2) {
          // Check for breakout
          const isBreakout = this.detectBreakout(candles, 'up');
          regime = isBreakout ? MarketRegime.BREAKING_OUT : MarketRegime.TRENDING_UP;
        } else if (trendDirection < -this.config.regimeDetectionParams.trendStrengthThreshold / 2) {
          // Check for breakdown
          const isBreakout = this.detectBreakout(candles, 'down');
          regime = isBreakout ? MarketRegime.BREAKING_OUT : MarketRegime.TRENDING_DOWN;
        } else {
          // Check for reversal
          const isReversal = this.detectReversal(candles);
          regime = isReversal ? MarketRegime.REVERSING : MarketRegime.RANGING;
        }
      }
      
      // Determine when this regime started
      const since = this.determineRegimeStartTime(candles, regime);
      
      return { regime, since };
    } catch (error) {
      this.logger.error(`Error detecting market regime: ${error.message}`);
      return { regime: MarketRegime.RANGING, since: Date.now() };
    }
  }
  
  /**
   * Calculate trend direction from price data
   * Returns a value between -1 and 1
   */
  private calculateTrendDirection(prices: number[]): number {
    if (prices.length < 5) return 0;
    
    // Calculate linear regression slope
    const n = prices.length;
    const x = Array.from({ length: n }, (_, i) => i);
    
    const xSum = x.reduce((sum, val) => sum + val, 0);
    const ySum = prices.reduce((sum, val) => sum + val, 0);
    const xySum = x.reduce((sum, val, i) => sum + (val * prices[i]), 0);
    const x2Sum = x.reduce((sum, val) => sum + (val * val), 0);
    
    const slope = (n * xySum - xSum * ySum) / (n * x2Sum - xSum * xSum);
    
    // Normalize slope to -1 to 1 range
    const avgPrice = ySum / n;
    const normalizedSlope = slope / avgPrice * 100;
    
    // Clamp to -1 to 1
    return Math.max(-1, Math.min(1, normalizedSlope));
  }
  
  /**
   * Calculate volatility from returns
   */
  private calculateVolatility(returns: number[]): number {
    if (returns.length < 5) return 0;
    
    // Calculate standard deviation of returns
    const mean = returns.reduce((sum, val) => sum + val, 0) / returns.length;
    const variance = returns.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / returns.length;
    
    return Math.sqrt(variance);
  }
  
  /**
   * Calculate volume trend
   */
  private calculateVolumeTrend(volumes: number[]): number {
    if (volumes.length < 10) return 0;
    
    // Split into two halves
    const mid = Math.floor(volumes.length / 2);
    const firstHalf = volumes.slice(0, mid);
    const secondHalf = volumes.slice(mid);
    
    // Calculate average volume for each half
    const avgFirst = firstHalf.reduce((sum, v) => sum + v, 0) / firstHalf.length;
    const avgSecond = secondHalf.reduce((sum, v) => sum + v, 0) / secondHalf.length;
    
    // Calculate percent change
    return (avgSecond - avgFirst) / avgFirst;
  }
  
  /**
   * Detect breakout from significant level
   */
  private detectBreakout(candles: any[], direction: 'up' | 'down'): boolean {
    if (candles.length < 20) return false;
    
    // Get recent candles
    const recentCandles = candles.slice(-20);
    
    // Calculate price levels from prior candles
    const olderCandles = candles.slice(0, candles.length - 20);
    const highs = olderCandles.map(c => c.high);
    const lows = olderCandles.map(c => c.low);
    
    // Find potential resistance/support levels
    const levels = [];
    const currentPrice = recentCandles[recentCandles.length - 1].close;
    
    if (direction === 'up') {
      // Look for resistance levels (cluster of highs)
      const sortedHighs = [...highs].sort((a, b) => a - b);
      
      // Find clusters (groups of similar prices)
      const clusters = [];
      let currentCluster = [sortedHighs[0]];
      
      for (let i = 1; i < sortedHighs.length; i++) {
        if (sortedHighs[i] - sortedHighs[i-1] < currentPrice * 0.005) {
          // Add to current cluster if close enough
          currentCluster.push(sortedHighs[i]);
        } else {
          // Start new cluster
          if (currentCluster.length >= 3) {
            clusters.push(currentCluster);
          }
          currentCluster = [sortedHighs[i]];
        }
      }
      
      // Add last cluster if significant
      if (currentCluster.length >= 3) {
        clusters.push(currentCluster);
      }
      
      // Calculate average price for each cluster and add as level
      for (const cluster of clusters) {
        const avgPrice = cluster.reduce((sum, p) => sum + p, 0) / cluster.length;
        levels.push(avgPrice);
      }
      
      // Check if price recently broke above any level
      for (const level of levels) {
        if (level < currentPrice && level > recentCandles[0].low) {
          return true;
        }
      }
    } else {
      // Look for support levels (cluster of lows)
      const sortedLows = [...lows].sort((a, b) => a - b);
      
      // Find clusters (groups of similar prices)
      const clusters = [];
      let currentCluster = [sortedLows[0]];
      
      for (let i = 1; i < sortedLows.length; i++) {
        if (sortedLows[i] - sortedLows[i-1] < currentPrice * 0.005) {
          // Add to current cluster if close enough
          currentCluster.push(sortedLows[i]);
        } else {
          // Start new cluster
          if (currentCluster.length >= 3) {
            clusters.push(currentCluster);
          }
          currentCluster = [sortedLows[i]];
        }
      }
      
      // Add last cluster if significant
      if (currentCluster.length >= 3) {
        clusters.push(currentCluster);
      }
      
      // Calculate average price for each cluster and add as level
      for (const cluster of clusters) {
        const avgPrice = cluster.reduce((sum, p) => sum + p, 0) / cluster.length;
        levels.push(avgPrice);
      }
      
      // Check if price recently broke below any level
      for (const level of levels) {
        if (level > currentPrice && level < recentCandles[0].high) {
          return true;
        }
      }
    }
    
    return false;
  }
  
  /**
   * Detect reversal pattern
   */
  private detectReversal(candles: any[]): boolean {
    if (candles.length < 30) return false;
    
    // Get recent candles
    const recentCandles = candles.slice(-10);
    const previousCandles = candles.slice(-30, -10);
    
    // Calculate recent trend
    const previousPrices = previousCandles.map(c => c.close);
    const recentPrices = recentCandles.map(c => c.close);
    
    const previousTrend = this.calculateTrendDirection(previousPrices);
    const recentTrend = this.calculateTrendDirection(recentPrices);
    
    // Check for trend reversal
    return (previousTrend > 0.3 && recentTrend < -0.3) || 
           (previousTrend < -0.3 && recentTrend > 0.3);
  }
  
  /**
   * Determine when a regime started
   */
  private determineRegimeStartTime(candles: any[], regime: MarketRegime): number {
    if (candles.length < 10) return Date.now();
    
    // Different logic based on regime type
    switch (regime) {
      case MarketRegime.TRENDING_UP:
      case MarketRegime.TRENDING_DOWN:
        return this.findTrendStart(candles, regime === MarketRegime.TRENDING_UP);
        
      case MarketRegime.VOLATILE:
        return this.findVolatilityStart(candles);
        
      case MarketRegime.RANGING:
        return this.findRangeStart(candles);
        
      case MarketRegime.BREAKING_OUT:
        return candles[candles.length - 5].timestamp; // Assume breakout is recent
        
      case MarketRegime.REVERSING:
        return candles[candles.length - 3].timestamp; // Assume reversal is very recent
        
      default:
        return candles[candles.length - 10].timestamp; // Default to 10 candles ago
    }
  }
  
  /**
   * Find when a trend started
   */
  private findTrendStart(candles: any[], isUptrend: boolean): number {
    const prices = candles.map(c => c.close);
    
    // Use a moving average crossover to estimate trend start
    const shortMA = this.calculateSMA(prices, 5);
    const longMA = this.calculateSMA(prices, 20);
    
    // Find where short MA crossed above/below long MA
    let crossoverIndex = -1;
    
    for (let i = 20; i < prices.length - 1; i++) {
      if (isUptrend) {
        if (shortMA[i-1] <= longMA[i-1] && shortMA[i] > longMA[i]) {
          crossoverIndex = i;
        }
      } else {
        if (shortMA[i-1] >= longMA[i-1] && shortMA[i] < longMA[i]) {
          crossoverIndex = i;
        }
      }
    }
    
    if (crossoverIndex === -1) {
      return candles[candles.length - 10].timestamp;
    }
    
    return candles[crossoverIndex].timestamp;
  }
  
  /**
   * Find when volatility increased
   */
  private findVolatilityStart(candles: any[]): number {
    const returns = [];
    
    for (let i = 1; i < candles.length; i++) {
      returns.push((candles[i].close - candles[i-1].close) / candles[i-1].close);
    }
    
    // Calculate rolling volatility
    const window = 10;
    const volatilities = [];
    
    for (let i = window; i < returns.length; i++) {
      const windowReturns = returns.slice(i - window, i);
      volatilities.push(this.calculateVolatility(windowReturns));
    }
    
    // Find significant volatility increase
    let volatilityJumpIndex = -1;
    
    for (let i = 1; i < volatilities.length; i++) {
      if (volatilities[i] > volatilities[i-1] * 2) {
        volatilityJumpIndex = i + window;
        break;
      }
    }
    
    if (volatilityJumpIndex === -1) {
      return candles[candles.length - 5].timestamp;
    }
    
    return candles[volatilityJumpIndex].timestamp;
  }
  
  /**
   * Find when a range started
   */
  private findRangeStart(candles: any[]): number {
    // Calculate moving average of price ranges
    const ranges = candles.map(c => c.high - c.low);
    const avgRanges = this.calculateSMA(ranges, 5);
    
    // Find where range contracted
    let rangeStartIndex = -1;
    
    for (let i = 5; i < ranges.length - 1; i++) {
      if (avgRanges[i] < avgRanges[i-1] * 0.7) {
        rangeStartIndex = i;
        break;
      }
    }
    
    if (rangeStartIndex === -1) {
      return candles[candles.length - 10].timestamp;
    }
    
    return candles[rangeStartIndex].timestamp;
  }
  
  /**
   * Calculate Simple Moving Average
   */
  private calculateSMA(data: number[], period: number): number[] {
    const result = [];
    
    for (let i = 0; i < data.length; i++) {
      if (i < period - 1) {
        result.push(NaN);
        continue;
      }
      
      const sum = data.slice(i - period + 1, i + 1).reduce((sum, val) => sum + val, 0);
      result.push(sum / period);
    }
    
    return result;
  }
  
  /**
   * Start market analysis for a specific market
   */
  private startMarketAnalysis(venue: string, symbol: string): void {
    const marketId = this.getMarketId(venue, symbol);
    
    // Clear existing interval if any
    if (this.analysisIntervals.has(marketId)) {
      clearInterval(this.analysisIntervals.get(marketId)!);
    }
    
    // Set up interval
    const interval = setInterval(async () => {
      if (!this.isRunning) return;
      
      try {
        await this.analyzeMarketStructure(venue, symbol);
      } catch (error) {
        this.logger.error(`Error analyzing market ${marketId}: ${error.message}`);
      }
    }, this.config.updateInterval);
    
    this.analysisIntervals.set(marketId, interval);
    this.logger.debug(`Started analysis for market ${marketId}`);
    
    // Perform initial analysis
    setTimeout(async () => {
      try {
        await this.analyzeMarketStructure(venue, symbol);
      } catch (error) {
        this.logger.error(`Error in initial analysis for ${marketId}: ${error.message}`);
      }
    }, 100);
  }
  
  /**
   * Update market regime if needed
   */
  private async updateMarketRegime(venue: string, symbol: string, analysis: MarketStructureAnalysis): Promise<void> {
    const marketId = this.getMarketId(venue, symbol);
    
    // Get current regime
    const currentRegime = this.marketRegimes.get(marketId);
    
    // Only check every hour (to avoid too frequent changes)
    if (currentRegime && Date.now() - currentRegime.since < 60 * 60 * 1000) {
      return;
    }
    
    // Detect new regime
    const newRegime = await this.detectMarketRegime(venue, symbol);
    
    // Update if regime changed
    if (!currentRegime || currentRegime.regime !== newRegime.regime) {
      this.marketRegimes.set(marketId, newRegime);
      
      // Emit event for regime change
      this.eventEmitter.emit('market:regime_change', {
        venue,
        symbol,
        previousRegime: currentRegime?.regime,
        newRegime: newRegime.regime,
        since: newRegime.since
      });
      
      this.logger.info(`Market regime changed for ${marketId}: ${newRegime.regime}`);
    }
  }
  
  /**
   * Handle new detected patterns
   */
  private async handleNewPatterns(venue: string, symbol: string, patterns: OrderFlowPattern[]): Promise<void> {
    const marketId = this.getMarketId(venue, symbol);
    
    // Add to stored patterns
    const existingPatterns = this.orderFlowPatterns.get(marketId) || [];
    this.orderFlowPatterns.set(marketId, [...existingPatterns, ...patterns]);
    
    // Save to repository
    await this.analyticsRepository.saveOrderFlowPatterns(venue, symbol, patterns);
    
    // Emit events
    for (const pattern of patterns) {
      this.eventEmitter.emit('market:pattern_detected', {
        venue,
        symbol,
        pattern
      });
      
      this.logger.info(`Detected pattern ${pattern.name} for ${marketId}`);
    }
  }
  
  /**
   * Save analysis result to time series database
   */
  private async saveAnalysisResult(analysis: MarketStructureAnalysis): Promise<void> {
    try {
      // Structure data for time series storage
      const point = {
        measurement: 'market_structure_analysis',
        tags: {
          venue: analysis.venue,
          symbol: analysis.symbol
        },
        fields: {
          bid_ask_imbalance: analysis.bidAskImbalance,
          order_flow_imbalance: analysis.orderFlowImbalance,
          market_depth_score: analysis.marketDepthScore,
          vwap_deviation: analysis.vwapDeviation,
          current_spread: analysis.spreadAnalysis.currentSpread,
          average_spread: analysis.spreadAnalysis.averageSpread,
          spread_volatility: analysis.spreadAnalysis.spreadVolatility,
          bid_liquidity: analysis.liquidityAnalysis.bidLiquidity,
          ask_liquidity: analysis.liquidityAnalysis.askLiquidity,
          liquidity_imbalance: analysis.liquidityAnalysis.liquidityImbalance,
          buy_volume: analysis.volumeProfile.buyVolume,
          sell_volume: analysis.volumeProfile.sellVolume,
          volume_imbalance: analysis.volumeProfile.volumeImbalance,
          signal_count: analysis.signals.length,
          strongest_signal_strength: analysis.signals.length > 0 ? analysis.signals[0].strength : 0,
          strongest_signal_type: analysis.signals.length > 0 ? analysis.signals[0].type : ''
        },
        timestamp: analysis.timestamp
      };
      
      // Write to time series database
      await this.timeSeriesDB.writePoint(point);
      
      // Record metrics
      this.metricsService.recordAnalysisCompletion(analysis.venue, analysis.symbol);
    } catch (error) {
      this.logger.error(`Error saving analysis result: ${error.message}`);
    }
  }
  
  /**
   * Load previously monitored markets
   */
  private async loadMonitoredMarkets(): Promise<void> {
    try {
      const markets = await this.analyticsRepository.getMonitoredMarkets();
      
      for (const market of markets) {
        if (market.active) {
          const marketId = this.getMarketId(market.venue, market.symbol);
          this.monitoredMarkets.add(marketId);
          
          if (this.isRunning) {
            this.startMarketAnalysis(market.venue, market.symbol);
          }
        }
      }
      
      this.logger.info(`Loaded ${this.monitoredMarkets.size} monitored markets`);
    } catch (error) {
      this.logger.error(`Error loading monitored markets: ${error.message}`);
    }
  }
  
  /**
   * Load price levels from repository
   */
  private async loadPriceLevels(): Promise<void> {
    try {
      // Load only for monitored markets
      for (const marketId of this.monitoredMarkets) {
        const [venue, symbol] = marketId.split(':');
        
        const levels = await this.analyticsRepository.getPriceLevels(venue, symbol);
        
        if (levels && levels.length > 0) {
          this.priceLevels.set(marketId, levels);
        }
      }
      
      this.logger.info(`Loaded price levels for ${this.priceLevels.size} markets`);
    } catch (error) {
      this.logger.error(`Error loading price levels: ${error.message}`);
    }
  }
  
  /**
   * Check if price level data is stale
   */
  private isPriceLevelDataStale(levels: PriceLevelAnalysis[]): boolean {
    if (levels.length === 0) return true;
    
    // Get newest last seen timestamp
    const newestTimestamp = Math.max(...levels.map(level => level.lastSeen));
    
    // Consider stale if oldest timestamp is more than 24 hours old
    return Date.now() - newestTimestamp > 24 * 60 * 60 * 1000;
  }
  
  /**
   * Get market ID from venue and symbol
   */
  private getMarketId(venue: string, symbol: string): string {
    return `${venue}:${symbol}`;
  }
  
  /**
   * Subscribe to relevant events
   */
  private subscribeToEvents(): void {
    // Subscribe to order book updates
    this.eventEmitter.on('orderbook:updated', async (data: any) => {
      try {
        const marketId = this.getMarketId(data.venue, data.symbol);
        
        // Only process if market is being monitored
        if (!this.monitoredMarkets.has(marketId)) return;
        
        // TODO: implement real-time update handling
      } catch (error) {
        this.logger.error(`Error handling orderbook update: ${error.message}`);
      }
    });
    
    // Subscribe to new trades
    this.eventEmitter.on('trades:new', async (data: any) => {
      try {
        const marketId = this.getMarketId(data.venue, data.symbol);
        
        // Only process if market is being monitored
        if (!this.monitoredMarkets.has(marketId)) return;
        
        // TODO: implement real-time trade processing
      } catch (error) {
        this.logger.error(`Error handling new trades: ${error.message}`);
      }
    });
    
    // Subscribe to config updates
    this.eventEmitter.on('config:updated', async (data: any) => {
      try {
        if (data.component === 'market-analysis') {
          this.config = { ...this.config, ...data.config };
          this.logger.info('Updated market analysis configuration');
        }
      } catch (error) {
        this.logger.error(`Error handling config update: ${error.message}`);
      }
    });
  }
}