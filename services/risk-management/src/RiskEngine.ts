          description: 'Low-risk profile with tight limits suitable for beginners',
          positionLimits: {
            'BTC-USD': {
              maxLongSize: 5,
              maxShortSize: 5,
              maxLongValue: 500000,
              maxShortValue: 500000
            },
            'ETH-USD': {
              maxLongSize: 50,
              maxShortSize: 50,
              maxLongValue: 500000,
              maxShortValue: 500000
            },
            'default': {
              maxLongSize: 5,
              maxShortSize: 5,
              maxLongValue: 50000,
              maxShortValue: 50000
            }
          },
          orderLimits: {
            maxOrderSize: 5,
            maxOrderValue: 50000,
            maxLeverage: 5,
            maxDailyOrders: 500
          },
          marginLimits: {
            maxMarginUtilization: 0.6,
            initialMarginRatio: 0.15,
            maintenanceMarginRatio: 0.075,
            liquidationThreshold: 0.85
          },
          riskLimits: {
            maxConcentration: 0.2,
            maxDrawdown: 0.2,
            maxDailyLoss: 5000,
            maxTradeFrequency: 30
          },
          actions: {
            [RiskLimitType.POSITION_SIZE]: RiskLimitAction.REJECT,
            [RiskLimitType.ORDER_SIZE]: RiskLimitAction.REJECT,
            [RiskLimitType.ORDER_VALUE]: RiskLimitAction.REJECT,
            [RiskLimitType.NOTIONAL_VALUE]: RiskLimitAction.WARN,
            [RiskLimitType.MARGIN_UTILIZATION]: RiskLimitAction.REJECT,
            [RiskLimitType.LEVERAGE]: RiskLimitAction.REJECT,
            [RiskLimitType.CONCENTRATION]: RiskLimitAction.WARN,
            [RiskLimitType.DRAWDOWN]: RiskLimitAction.WARN,
            [RiskLimitType.DAILY_LOSS]: RiskLimitAction.REDUCE_ONLY,
            [RiskLimitType.TRADE_FREQUENCY]: RiskLimitAction.WARN
          },
          defaultExemptions: []
        },
        {
          id: 'moderate',
          name: 'Moderate',
          description: 'Balanced risk profile for experienced traders',
          positionLimits: {
            'BTC-USD': {
              maxLongSize: 10,
              maxShortSize: 10,
              maxLongValue: 1000000,
              maxShortValue: 1000000
            },
            'ETH-USD': {
              maxLongSize: 100,
              maxShortSize: 100,
              maxLongValue: 1000000,
              maxShortValue: 1000000
            },
            'default': {
              maxLongSize: 10,
              maxShortSize: 10,
              maxLongValue: 100000,
              maxShortValue: 100000
            }
          },
          orderLimits: {
            maxOrderSize: 10,
            maxOrderValue: 100000,
            maxLeverage: 10,
            maxDailyOrders: 1000
          },
          marginLimits: {
            maxMarginUtilization: 0.8,
            initialMarginRatio: 0.1,
            maintenanceMarginRatio: 0.05,
            liquidationThreshold: 0.9
          },
          riskLimits: {
            maxConcentration: 0.25,
            maxDrawdown: 0.3,
            maxDailyLoss: 10000,
            maxTradeFrequency: 60
          },
          actions: {
            [RiskLimitType.POSITION_SIZE]: RiskLimitAction.REJECT,
            [RiskLimitType.ORDER_SIZE]: RiskLimitAction.REJECT,
            [RiskLimitType.ORDER_VALUE]: RiskLimitAction.REJECT,
            [RiskLimitType.NOTIONAL_VALUE]: RiskLimitAction.WARN,
            [RiskLimitType.MARGIN_UTILIZATION]: RiskLimitAction.REJECT,
            [RiskLimitType.LEVERAGE]: RiskLimitAction.REJECT,
            [RiskLimitType.CONCENTRATION]: RiskLimitAction.WARN,
            [RiskLimitType.DRAWDOWN]: RiskLimitAction.WARN,
            [RiskLimitType.DAILY_LOSS]: RiskLimitAction.REDUCE_ONLY,
            [RiskLimitType.TRADE_FREQUENCY]: RiskLimitAction.WARN
          },
          defaultExemptions: []
        },
        {
          id: 'aggressive',
          name: 'Aggressive',
          description: 'High-risk profile for professional traders',
          positionLimits: {
            'BTC-USD': {
              maxLongSize: 20,
              maxShortSize: 20,
              maxLongValue: 2000000,
              maxShortValue: 2000000
            },
            'ETH-USD': {
              maxLongSize: 200,
              maxShortSize: 200,
              maxLongValue: 2000000,
              maxShortValue: 2000000
            },
            'default': {
              maxLongSize: 20,
              maxShortSize: 20,
              maxLongValue: 200000,
              maxShortValue: 200000
            }
          },
          orderLimits: {
            maxOrderSize: 20,
            maxOrderValue: 200000,
            maxLeverage: 20,
            maxDailyOrders: 2000
          },
          marginLimits: {
            maxMarginUtilization: 0.9,
            initialMarginRatio: 0.05,
            maintenanceMarginRatio: 0.025,
            liquidationThreshold: 0.95
          },
          riskLimits: {
            maxConcentration: 0.4,
            maxDrawdown: 0.4,
            maxDailyLoss: 20000,
            maxTradeFrequency: 120
          },
          actions: {
            [RiskLimitType.POSITION_SIZE]: RiskLimitAction.REJECT,
            [RiskLimitType.ORDER_SIZE]: RiskLimitAction.WARN,
            [RiskLimitType.ORDER_VALUE]: RiskLimitAction.WARN,
            [RiskLimitType.NOTIONAL_VALUE]: RiskLimitAction.NOTIFY,
            [RiskLimitType.MARGIN_UTILIZATION]: RiskLimitAction.REJECT,
            [RiskLimitType.LEVERAGE]: RiskLimitAction.REJECT,
            [RiskLimitType.CONCENTRATION]: RiskLimitAction.NOTIFY,
            [RiskLimitType.DRAWDOWN]: RiskLimitAction.NOTIFY,
            [RiskLimitType.DAILY_LOSS]: RiskLimitAction.WARN,
            [RiskLimitType.TRADE_FREQUENCY]: RiskLimitAction.NOTIFY
          },
          defaultExemptions: [RiskLimitType.TRADE_FREQUENCY]
        },
        {
          id: 'institutional',
          name: 'Institutional',
          description: 'Tailored for institutional clients with high capital',
          positionLimits: {
            'BTC-USD': {
              maxLongSize: 100,
              maxShortSize: 100,
              maxLongValue: 10000000,
              maxShortValue: 10000000
            },
            'ETH-USD': {
              maxLongSize: 1000,
              maxShortSize: 1000,
              maxLongValue: 10000000,
              maxShortValue: 10000000
            },
            'default': {
              maxLongSize: 50,
              maxShortSize: 50,
              maxLongValue: 1000000,
              maxShortValue: 1000000
            }
          },
          orderLimits: {
            maxOrderSize: 50,
            maxOrderValue: 1000000,
            maxLeverage: 10,
            maxDailyOrders: 5000
          },
          marginLimits: {
            maxMarginUtilization: 0.85,
            initialMarginRatio: 0.08,
            maintenanceMarginRatio: 0.04,
            liquidationThreshold: 0.92
          },
          riskLimits: {
            maxConcentration: 0.3,
            maxDrawdown: 0.35,
            maxDailyLoss: 100000,
            maxTradeFrequency: 500
          },
          actions: {
            [RiskLimitType.POSITION_SIZE]: RiskLimitAction.WARN,
            [RiskLimitType.ORDER_SIZE]: RiskLimitAction.WARN,
            [RiskLimitType.ORDER_VALUE]: RiskLimitAction.WARN,
            [RiskLimitType.NOTIONAL_VALUE]: RiskLimitAction.NOTIFY,
            [RiskLimitType.MARGIN_UTILIZATION]: RiskLimitAction.WARN,
            [RiskLimitType.LEVERAGE]: RiskLimitAction.WARN,
            [RiskLimitType.CONCENTRATION]: RiskLimitAction.NOTIFY,
            [RiskLimitType.DRAWDOWN]: RiskLimitAction.NOTIFY,
            [RiskLimitType.DAILY_LOSS]: RiskLimitAction.NOTIFY,
            [RiskLimitType.TRADE_FREQUENCY]: RiskLimitAction.NOTIFY
          },
          defaultExemptions: [
            RiskLimitType.TRADE_FREQUENCY,
            RiskLimitType.CONCENTRATION
          ]
        }
      ];
      
      // Save default profiles
      for (const profile of defaultProfiles) {
        this.riskProfiles.set(profile.id, profile);
        await this.saveRiskProfile(profile);
      }
      
      this.logger.info(`Created ${defaultProfiles.length} default risk profiles`);
    } catch (error) {
      this.logger.error(`Error creating default risk profiles: ${error.message}`);
    }
  }
  
  /**
   * Load account limits from repository
   */
  private async loadAccountLimits(): Promise<void> {
    try {
      const accounts = await this.accountService.getAllAccountIds();
      
      for (const accountId of accounts) {
        const limits = await this.riskRepository.getAccountLimits(accountId);
        
        if (limits) {
          this.accountLimits.set(accountId, limits);
        }
      }
      
      this.logger.info(`Loaded risk limits for ${this.accountLimits.size} accounts`);
    } catch (error) {
      this.logger.error(`Error loading account limits: ${error.message}`);
    }
  }
  
  /**
   * Save account limits to repository
   */
  private async saveAccountLimits(accountId: string, limits: AccountRiskLimits): Promise<void> {
    try {
      await this.riskRepository.saveAccountLimits(accountId, limits);
    } catch (error) {
      this.logger.error(`Error saving account limits for ${accountId}: ${error.message}`);
    }
  }
  
  /**
   * Save risk profile to repository
   */
  private async saveRiskProfile(profile: RiskProfile): Promise<void> {
    try {
      await this.riskRepository.saveRiskProfile(profile);
    } catch (error) {
      this.logger.error(`Error saving risk profile ${profile.id}: ${error.message}`);
    }
  }
  
  /**
   * Subscribe to events
   */
  private subscribeToEvents(): void {
    // Subscribe to order events
    this.eventEmitter.on('order:created', async (data: any) => {
      try {
        if (!this.isRunning) return;
        
        const { accountId, userId, order } = data;
        await this.checkOrderRisk(accountId, userId, order);
      } catch (error) {
        this.logger.error(`Error handling order:created event: ${error.message}`);
      }
    });
    
    // Subscribe to position updates
    this.eventEmitter.on('position:updated', async (data: any) => {
      try {
        if (!this.isRunning) return;
        
        const { accountId, symbol } = data;
        await this.checkPositionRisk(accountId, symbol);
      } catch (error) {
        this.logger.error(`Error handling position:updated event: ${error.message}`);
      }
    });
    
    // Subscribe to account updates
    this.eventEmitter.on('account:updated', async (data: any) => {
      try {
        if (!this.isRunning) return;
        
        const { accountId } = data;
        const positions = await this.positionService.getAllPositions(accountId);
        
        // Check risk for all positions
        for (const position of positions) {
          if (position.size !== 0) {
            await this.checkPositionRisk(accountId, position.symbol);
          }
        }
      } catch (error) {
        this.logger.error(`Error handling account:updated event: ${error.message}`);
      }
    });
    
    // Subscribe to risk profile updates
    this.eventEmitter.on('risk:profile_updated', async (data: any) => {
      try {
        if (!this.isRunning) return;
        
        const { profile } = data;
        await this.updateRiskProfile(profile.id, profile);
      } catch (error) {
        this.logger.error(`Error handling risk:profile_updated event: ${error.message}`);
      }
    });
    
    // Subscribe to account risk limit updates
    this.eventEmitter.on('risk:limits_updated', async (data: any) => {
      try {
        if (!this.isRunning) return;
        
        const { accountId, limits } = data;
        await this.updateAccountLimits(accountId, limits);
      } catch (error) {
        this.logger.error(`Error handling risk:limits_updated event: ${error.message}`);
      }
    });
  }
  
  /**
   * Start position monitoring loop
   */
  private startPositionMonitoring(): void {
    // Run risk checks on all positions periodically
    this.positionMonitorInterval = setInterval(async () => {
      try {
        if (!this.isRunning) return;
        
        // Get all accounts with active positions
        const accountsWithPositions = await this.positionService.getAccountsWithPositions();
        
        for (const accountId of accountsWithPositions) {
          const positions = await this.positionService.getAllPositions(accountId);
          
          // Check risk for each active position
          for (const position of positions) {
            if (position.size !== 0) {
              await this.checkPositionRisk(accountId, position.symbol);
            }
          }
        }
      } catch (error) {
        this.logger.error(`Error in position monitoring loop: ${error.message}`);
      }
    }, 60000); // Check every minute
  }
}