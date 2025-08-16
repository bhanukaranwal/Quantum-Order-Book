          route.venue, 
          order.symbol, 
          route.quantity
        );
      }
    }
    
    return routes;
  }
  
  /**
   * Parse custom routing instructions
   */
  private parseCustomRouting(order: any): OrderRoute['routes'] {
    if (!order.routingInstructions || !Array.isArray(order.routingInstructions)) {
      throw new Error('Custom routing requires valid routing instructions');
    }
    
    const routes: OrderRoute['routes'] = [];
    let totalPercentage = 0;
    
    for (const instruction of order.routingInstructions) {
      if (!instruction.venue || !instruction.percentage) {
        throw new Error('Each routing instruction must specify venue and percentage');
      }
      
      totalPercentage += instruction.percentage;
      
      const quantity = (instruction.percentage / 100) * order.quantity;
      
      routes.push({
        venue: instruction.venue,
        quantity,
        percentage: instruction.percentage,
        estimatedCost: this.estimateExecutionCost(instruction.venue, order.symbol, quantity),
        estimatedSlippage: this.estimateSlippage(instruction.venue, order.symbol, quantity),
        orderParams: instruction.orderParams
      });
    }
    
    // Validate total percentage
    if (Math.abs(totalPercentage - 100) > 0.001) {
      throw new Error('Routing instruction percentages must sum to 100%');
    }
    
    return routes;
  }
  
  /**
   * Find the best venue for a symbol
   */
  private async findBestVenue(symbol: string, availableVenues: string[]): Promise<string | null> {
    if (availableVenues.length === 0) return null;
    
    // If there's only one venue, return it
    if (availableVenues.length === 1) return availableVenues[0];
    
    // Calculate combined score for each venue
    const scores: Array<{ venue: string; score: number }> = [];
    
    for (const venue of availableVenues) {
      const score = await this.calculateCombinedScore(venue, symbol);
      scores.push({ venue, score });
    }
    
    // Sort by score (descending)
    scores.sort((a, b) => b.score - a.score);
    
    // Return the venue with the highest score
    return scores[0].venue;
  }
  
  /**
   * Calculate combined score for a venue
   */
  private async calculateCombinedScore(venue: string, symbol: string): Promise<number> {
    const venueInfo = this.venues.get(venue);
    
    if (!venueInfo) return 0;
    
    // Get weights
    const weights = venueInfo.weights;
    
    // Update venue scores for this symbol if needed
    await this.recalculateVenueScores(venue, symbol);
    
    // Calculate weighted score
    const weightedScore = (
      (venueInfo.liquidityScore * weights.liquidity) +
      (venueInfo.costScore * weights.cost) +
      (venueInfo.responseTimeScore * weights.responseTime) +
      (venueInfo.reliabilityScore * weights.reliability) +
      (venueInfo.spreadScore * weights.spread) +
      (venueInfo.slippageScore * weights.slippage)
    );
    
    // Normalize by sum of weights
    const sumOfWeights = Object.values(weights).reduce((sum, weight) => sum + weight, 0);
    
    return weightedScore / sumOfWeights;
  }
  
  /**
   * Recalculate venue scores for a specific symbol
   */
  private async recalculateVenueScores(venue: string, symbol: string): Promise<void> {
    const venueInfo = this.venues.get(venue);
    
    if (!venueInfo) return;
    
    // Get venue stats for this symbol
    const venueStatsMap = this.venueStats.get(venue);
    const stats = venueStatsMap?.get(symbol);
    
    // If we have stats, update scores
    if (stats) {
      // Liquidity score based on recent volume
      if (stats.totalVolume > 0) {
        // Get total volume across all venues for this symbol
        let totalVolume = 0;
        
        for (const [venueName, statsMap] of this.venueStats.entries()) {
          const venueStats = statsMap.get(symbol);
          if (venueStats) {
            totalVolume += venueStats.totalVolume;
          }
        }
        
        // Calculate liquidity score
        if (totalVolume > 0) {
          venueInfo.liquidityScore = Math.min(stats.totalVolume / totalVolume * 2, 1);
        }
      }
      
      // Response time score (lower is better)
      if (stats.averageResponseTime > 0) {
        // Collect response times from all venues
        const responseTimes: number[] = [];
        
        for (const [venueName, statsMap] of this.venueStats.entries()) {
          const venueStats = statsMap.get(symbol);
          if (venueStats && venueStats.averageResponseTime > 0) {
            responseTimes.push(venueStats.averageResponseTime);
          }
        }
        
        if (responseTimes.length > 0) {
          // Find min and max response times
          const minResponseTime = Math.min(...responseTimes);
          const maxResponseTime = Math.max(...responseTimes);
          
          if (maxResponseTime > minResponseTime) {
            // Normalize between 0 and 1 (1 is best/fastest)
            venueInfo.responseTimeScore = 1 - ((stats.averageResponseTime - minResponseTime) / (maxResponseTime - minResponseTime));
          }
        }
      }
      
      // Reliability score based on success rate
      venueInfo.reliabilityScore = stats.successRate;
      
      // Slippage score (lower slippage is better)
      if (stats.averageSlippage !== undefined) {
        // Collect slippage from all venues
        const slippages: number[] = [];
        
        for (const [venueName, statsMap] of this.venueStats.entries()) {
          const venueStats = statsMap.get(symbol);
          if (venueStats && venueStats.averageSlippage !== undefined) {
            slippages.push(venueStats.averageSlippage);
          }
        }
        
        if (slippages.length > 0) {
          // Find min and max slippage
          const minSlippage = Math.min(...slippages);
          const maxSlippage = Math.max(...slippages);
          
          if (maxSlippage > minSlippage) {
            // Normalize between 0 and 1 (1 is best/lowest slippage)
            venueInfo.slippageScore = 1 - ((stats.averageSlippage - minSlippage) / (maxSlippage - minSlippage));
          }
        }
      }
    }
    
    // Update cost score based on fee structure
    venueInfo.costScore = 1 - (this.estimateVenueCost(venue, symbol) / 100);
    
    // Update spread score based on current order book
    try {
      const orderBook = await this.marketDataService.getOrderBook(venue, symbol);
      
      if (orderBook && orderBook.bids && orderBook.asks && 
          orderBook.bids.length > 0 && orderBook.asks.length > 0) {
        
        const bestBid = orderBook.bids[0][0];
        const bestAsk = orderBook.asks[0][0];
        const spread = bestAsk - bestBid;
        const spreadPercent = spread / ((bestAsk + bestBid) / 2);
        
        // Collect spreads from all venues
        const spreads: number[] = [];
        const availableVenues = await this.getAvailableVenues(symbol);
        
        for (const venueName of availableVenues) {
          const venueOrderBook = await this.marketDataService.getOrderBook(venueName, symbol);
          
          if (venueOrderBook && venueOrderBook.bids && venueOrderBook.asks && 
              venueOrderBook.bids.length > 0 && venueOrderBook.asks.length > 0) {
            
            const venueBestBid = venueOrderBook.bids[0][0];
            const venueBestAsk = venueOrderBook.asks[0][0];
            const venueSpread = venueBestAsk - venueBestBid;
            const venueSpreadPercent = venueSpread / ((venueBestAsk + venueBestBid) / 2);
            
            spreads.push(venueSpreadPercent);
          }
        }
        
        if (spreads.length > 0) {
          // Find min and max spread
          const minSpread = Math.min(...spreads);
          const maxSpread = Math.max(...spreads);
          
          if (maxSpread > minSpread) {
            // Normalize between 0 and 1 (1 is best/lowest spread)
            venueInfo.spreadScore = 1 - ((spreadPercent - minSpread) / (maxSpread - minSpread));
          }
        }
      }
    } catch (error) {
      this.logger.error(`Error updating spread score: ${error.message}`);
    }
    
    // Apply adaptive weighting if enabled
    if (this.config.adaptiveWeightingEnabled) {
      this.adjustWeights(venueInfo);
    }
  }
  
  /**
   * Adjust weights based on performance
   */
  private adjustWeights(venueInfo: VenueInfo): void {
    // Normalize all scores to prevent any single factor from dominating
    const scores = {
      liquidity: venueInfo.liquidityScore,
      cost: venueInfo.costScore,
      responseTime: venueInfo.responseTimeScore,
      reliability: venueInfo.reliabilityScore,
      spread: venueInfo.spreadScore,
      slippage: venueInfo.slippageScore
    };
    
    // Find lowest and highest scores
    const lowestScore = Math.min(...Object.values(scores));
    const highestScore = Math.max(...Object.values(scores));
    
    // Adjust weights to compensate for weaknesses
    const weights = { ...venueInfo.weights };
    const totalWeight = Object.values(weights).reduce((sum, w) => sum + w, 0);
    
    // If any score is significantly below average, reduce its weight
    for (const [key, score] of Object.entries(scores)) {
      const scoreRange = highestScore - lowestScore;
      
      if (scoreRange > 0) {
        const normalizedScore = (score - lowestScore) / scoreRange;
        
        // If this score is one of the lowest, reduce its weight
        if (normalizedScore < 0.3) {
          weights[key as keyof typeof weights] *= 0.8;
        }
        // If this score is one of the highest, increase its weight
        else if (normalizedScore > 0.7) {
          weights[key as keyof typeof weights] *= 1.2;
        }
      }
    }
    
    // Normalize weights back to original sum
    const newTotalWeight = Object.values(weights).reduce((sum, w) => sum + w, 0);
    const scaleFactor = totalWeight / newTotalWeight;
    
    for (const key of Object.keys(weights)) {
      weights[key as keyof typeof weights] *= scaleFactor;
    }
    
    // Update venue weights
    venueInfo.weights = weights;
  }
  
  /**
   * Get liquidity distribution across venues
   */
  private async getLiquidityDistribution(
    symbol: string, 
    venues: string[]
  ): Promise<Array<{ venue: string; liquidity: number }>> {
    try {
      const result: Array<{ venue: string; liquidity: number }> = [];
      
      for (const venue of venues) {
        // Get order book for this venue
        const orderBook = await this.marketDataService.getOrderBook(venue, symbol);
        
        if (!orderBook || !orderBook.bids || !orderBook.asks) {
          result.push({ venue, liquidity: 0 });
          continue;
        }
        
        // Calculate available liquidity (sum of bid quantities)
        let liquidity = 0;
        
        for (const [price, quantity] of orderBook.bids) {
          liquidity += quantity;
        }
        
        result.push({ venue, liquidity });
      }
      
      return result;
    } catch (error) {
      this.logger.error(`Error getting liquidity distribution: ${error.message}`);
      return venues.map(venue => ({ venue, liquidity: 0 }));
    }
  }
  
  /**
   * Estimate execution cost for a venue
   */
  private estimateExecutionCost(venue: string, symbol: string, quantity: number): number {
    // Get fee structure for this venue
    const feeStructure = this.exchangeManager.getVenueFeeStructure(venue);
    
    if (!feeStructure) return 0;
    
    // Calculate cost in basis points
    let costBps = feeStructure.takerFeeBps || 0;
    
    // Add spread cost
    const spread = this.estimateSpread(venue, symbol);
    costBps += (spread * 10000); // Convert to basis points
    
    // Calculate cost as percentage of order value
    return costBps * quantity / 10000;
  }
  
  /**
   * Estimate spread for a venue
   */
  private estimateSpread(venue: string, symbol: string): number {
    // Try to get spread from cached order book
    const orderBook = this.marketDataService.getCachedOrderBook(venue, symbol);
    
    if (orderBook && orderBook.bids && orderBook.asks && 
        orderBook.bids.length > 0 && orderBook.asks.length > 0) {
      
      const bestBid = orderBook.bids[0][0];
      const bestAsk = orderBook.asks[0][0];
      
      return (bestAsk - bestBid) / ((bestAsk + bestBid) / 2);
    }
    
    // Default spread estimate
    return 0.001; // 0.1%
  }
  
  /**
   * Estimate slippage for executing an order
   */
  private estimateSlippage(venue: string, symbol: string, quantity: number): number {
    // Try to get from venue stats
    const venueStatsMap = this.venueStats.get(venue);
    const stats = venueStatsMap?.get(symbol);
    
    if (stats && stats.averageSlippage !== undefined) {
      // Scale slippage based on order size
      return stats.averageSlippage * Math.sqrt(quantity / 1); // Assuming 1 is base size
    }
    
    // Try to estimate from order book
    const orderBook = this.marketDataService.getCachedOrderBook(venue, symbol);
    
    if (orderBook && orderBook.bids && orderBook.asks && 
        orderBook.bids.length > 0 && orderBook.asks.length > 0) {
      
      // Simple estimation based on available liquidity
      const bestPrice = orderBook.bids[0][0]; // Assuming selling
      let remainingQuantity = quantity;
      let totalValue = 0;
      
      for (const [price, available] of orderBook.bids) {
        const fillQuantity = Math.min(remainingQuantity, available);
        totalValue += fillQuantity * price;
        remainingQuantity -= fillQuantity;
        
        if (remainingQuantity <= 0) break;
      }
      
      if (remainingQuantity > 0) {
        // Not enough liquidity in order book
        return 0.01; // Assume 1% slippage
      }
      
      const averagePrice = totalValue / quantity;
      return Math.abs(bestPrice - averagePrice) / bestPrice;
    }
    
    // Default slippage estimate
    return 0.002; // 0.2%
  }
  
  /**
   * Estimate cost in basis points for a venue
   */
  private estimateVenueCost(venue: string, symbol: string): number {
    // Get fee structure for this venue
    const feeStructure = this.exchangeManager.getVenueFeeStructure(venue);
    
    if (!feeStructure) return 20; // Default to 0.2%
    
    return feeStructure.takerFeeBps || 20;
  }
  
  /**
   * Save routing decision
   */
  private async saveRoutingDecision(route: OrderRoute): Promise<void> {
    try {
      await this.orderRepository.saveOrderRoute(route);
    } catch (error) {
      this.logger.error(`Error saving routing decision: ${error.message}`);
    }
  }
  
  /**
   * Update venue scores periodically
   */
  private async updateVenueScores(): Promise<void> {
    try {
      if (!this.isRunning) return;
      
      this.logger.debug('Updating venue scores');
      
      // Update scores for each venue and symbol combination
      for (const [venueName, venueStatsMap] of this.venueStats.entries()) {
        for (const [symbol, stats] of venueStatsMap.entries()) {
          await this.recalculateVenueScores(venueName, symbol);
        }
      }
      
      // Apply decay to execution stats to emphasize recent data
      this.applyStatsDecay();
      
      this.logger.debug('Venue scores updated');
    } catch (error) {
      this.logger.error(`Error updating venue scores: ${error.message}`);
    }
  }
  
  /**
   * Apply decay to execution stats
   */
  private applyStatsDecay(): void {
    const decayFactor = this.config.scoringDecayFactor;
    
    for (const [venueName, venueStatsMap] of this.venueStats.entries()) {
      for (const [symbol, stats] of venueStatsMap.entries()) {
        // Apply decay to counters
        stats.recentExecutions = Math.floor(stats.recentExecutions * decayFactor);
        stats.recentErrors = Math.floor(stats.recentErrors * decayFactor);
        
        // Remove stats if they become insignificant
        if (stats.recentExecutions < 1 && stats.totalVolume < 0.1) {
          venueStatsMap.delete(symbol);
        }
      }
      
      // Remove venue if no symbols remain
      if (venueStatsMap.size === 0) {
        this.venueStats.delete(venueName);
      }
    }
  }
}