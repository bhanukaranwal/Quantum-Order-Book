import { Request, Response, NextFunction } from 'express';
import { Redis } from 'ioredis';
import { Logger } from '../utils/Logger';
import { UserService } from '../services/UserService';
import { ConfigService } from '../services/ConfigService';

/**
 * Rate limit rule
 */
interface RateLimitRule {
  id: string;
  name: string;
  path: string;
  method: string | string[];
  limit: number;
  window: number; // in seconds
  weight?: number;
  userTier?: string | string[];
  ipBased: boolean;
  bypassKey?: boolean;
  errorMessage?: string;
  priority: number;
}

/**
 * Rate limit state
 */
interface RateLimitState {
  counter: number;
  resetTime: number;
  lastUpdated: number;
}

/**
 * User tier information
 */
interface UserTier {
  id: string;
  name: string;
  limits: {
    requestsPerSecond: number;
    requestsPerMinute: number;
    requestsPerHour: number;
    requestsPerDay: number;
    burstCapacity: number;
  };
  allowedPaths?: string[];
  priority: number;
}

/**
 * Dynamic rate limiter with support for user tiers and complex rules
 */
export class DynamicRateLimiter {
  private redis: Redis;
  private logger: Logger;
  private userService: UserService;
  private configService: ConfigService;
  
  private rules: RateLimitRule[] = [];
  private userTiers: UserTier[] = [];
  private pathRegexCache: Map<string, RegExp> = new Map();
  private bypassTokens: Set<string> = new Set();
  private defaultLimits = {
    requestsPerSecond: 10,
    requestsPerMinute: 100,
    requestsPerHour: 1000,
    requestsPerDay: 10000
  };
  
  constructor(
    redis: Redis,
    logger: Logger,
    userService: UserService,
    configService: ConfigService
  ) {
    this.redis = redis;
    this.logger = logger;
    this.userService = userService;
    this.configService = configService;
  }
  
  /**
   * Initialize the rate limiter with configurations
   */
  public async initialize(): Promise<void> {
    try {
      // Load configurations
      await this.loadRules();
      await this.loadUserTiers();
      await this.loadBypassTokens();
      
      // Subscribe to configuration changes
      this.configService.subscribeToChanges('rate-limits', async () => {
        await this.loadRules();
      });
      
      this.configService.subscribeToChanges('user-tiers', async () => {
        await this.loadUserTiers();
      });
      
      this.logger.info('Dynamic rate limiter initialized', {
        rulesCount: this.rules.length,
        userTiersCount: this.userTiers.length,
        bypassTokensCount: this.bypassTokens.size
      });
    } catch (error) {
      this.logger.error('Failed to initialize rate limiter', { error });
      throw error;
    }
  }
  
  /**
   * Create Express middleware for rate limiting
   */
  public middleware() {
    return async (req: Request, res: Response, next: NextFunction) => {
      try {
        // Skip rate limiting for health and readiness checks
        if (req.path === '/health' || req.path === '/readiness') {
          return next();
        }
        
        // Check for bypass token
        const apiKey = req.header('X-API-Key') || req.query.api_key as string;
        if (apiKey && this.bypassTokens.has(apiKey)) {
          return next();
        }
        
        // Get client identifier (user ID or IP)
        const userId = req.user?.id || 'anonymous';
        const clientIp = this.getClientIp(req);
        
        // Get user tier if authenticated
        const userTier = req.user ? await this.getUserTier(req.user.id) : 'anonymous';
        
        // Match request to rules
        const matchedRules = this.getMatchingRules(req, userTier);
        
        // If no rules match, apply default limits
        if (matchedRules.length === 0) {
          const defaultPassed = await this.checkDefaultLimits(userId, clientIp, userTier);
          if (!defaultPassed) {
            return this.sendRateLimitError(res, 'Rate limit exceeded. Please try again later.');
          }
          return next();
        }
        
        // Check each matched rule
        for (const rule of matchedRules) {
          const identifier = rule.ipBased ? 
            `ip:${clientIp}:${rule.id}` : 
            `user:${userId}:${rule.id}`;
            
          const passed = await this.checkRateLimitRule(identifier, rule);
          
          if (!passed) {
            return this.sendRateLimitError(
              res, 
              rule.errorMessage || 'Rate limit exceeded. Please try again later.'
            );
          }
        }
        
        // All rate limit checks passed
        next();
      } catch (error) {
        this.logger.error('Error in rate limiter middleware', { error });
        
        // Allow request to proceed on rate limiter errors
        next();
      }
    };
  }
  
  /**
   * Add a new rate limit rule
   */
  public async addRule(rule: RateLimitRule): Promise<void> {
    // Validate rule
    if (!rule.id || !rule.path || !rule.limit || !rule.window) {
      throw new Error('Invalid rate limit rule');
    }
    
    // Add rule to the list
    this.rules.push(rule);
    
    // Sort rules by priority (higher first)
    this.rules.sort((a, b) => b.priority - a.priority);
    
    // Save to config service
    await this.configService.saveConfig('rate-limits', this.rules);
    
    this.logger.info('Added rate limit rule', { rule });
  }
  
  /**
   * Update an existing rate limit rule
   */
  public async updateRule(ruleId: string, updates: Partial<RateLimitRule>): Promise<void> {
    const ruleIndex = this.rules.findIndex(r => r.id === ruleId);
    if (ruleIndex === -1) {
      throw new Error(`Rule not found: ${ruleId}`);
    }
    
    // Update rule
    this.rules[ruleIndex] = {
      ...this.rules[ruleIndex],
      ...updates
    };
    
    // Sort rules by priority (higher first)
    this.rules.sort((a, b) => b.priority - a.priority);
    
    // Save to config service
    await this.configService.saveConfig('rate-limits', this.rules);
    
    this.logger.info('Updated rate limit rule', { ruleId, updates });
  }
  
  /**
   * Delete a rate limit rule
   */
  public async deleteRule(ruleId: string): Promise<void> {
    const initialLength = this.rules.length;
    this.rules = this.rules.filter(rule => rule.id !== ruleId);
    
    if (this.rules.length === initialLength) {
      throw new Error(`Rule not found: ${ruleId}`);
    }
    
    // Save to config service
    await this.configService.saveConfig('rate-limits', this.rules);
    
    this.logger.info('Deleted rate limit rule', { ruleId });
  }
  
  /**
   * Add a new user tier
   */
  public async addUserTier(tier: UserTier): Promise<void> {
    // Validate tier
    if (!tier.id || !tier.name || !tier.limits) {
      throw new Error('Invalid user tier');
    }
    
    // Add tier to the list
    this.userTiers.push(tier);
    
    // Sort tiers by priority (higher first)
    this.userTiers.sort((a, b) => b.priority - a.priority);
    
    // Save to config service
    await this.configService.saveConfig('user-tiers', this.userTiers);
    
    this.logger.info('Added user tier', { tier });
  }
  
  /**
   * Update an existing user tier
   */
  public async updateUserTier(tierId: string, updates: Partial<UserTier>): Promise<void> {
    const tierIndex = this.userTiers.findIndex(t => t.id === tierId);
    if (tierIndex === -1) {
      throw new Error(`User tier not found: ${tierId}`);
    }
    
    // Update tier
    this.userTiers[tierIndex] = {
      ...this.userTiers[tierIndex],
      ...updates
    };
    
    // Sort tiers by priority (higher first)
    this.userTiers.sort((a, b) => b.priority - a.priority);
    
    // Save to config service
    await this.configService.saveConfig('user-tiers', this.userTiers);
    
    this.logger.info('Updated user tier', { tierId, updates });
  }
  
  /**
   * Delete a user tier
   */
  public async deleteUserTier(tierId: string): Promise<void> {
    const initialLength = this.userTiers.length;
    this.userTiers = this.userTiers.filter(tier => tier.id !== tierId);
    
    if (this.userTiers.length === initialLength) {
      throw new Error(`User tier not found: ${tierId}`);
    }
    
    // Save to config service
    await this.configService.saveConfig('user-tiers', this.userTiers);
    
    this.logger.info('Deleted user tier', { tierId });
  }
  
  /**
   * Add a bypass token
   */
  public async addBypassToken(token: string): Promise<void> {
    this.bypassTokens.add(token);
    
    // Save to config service
    await this.configService.saveConfig('bypass-tokens', Array.from(this.bypassTokens));
    
    this.logger.info('Added bypass token');
  }
  
  /**
   * Remove a bypass token
   */
  public async removeBypassToken(token: string): Promise<void> {
    const removed = this.bypassTokens.delete(token);
    
    if (!removed) {
      throw new Error('Bypass token not found');
    }
    
    // Save to config service
    await this.configService.saveConfig('bypass-tokens', Array.from(this.bypassTokens));
    
    this.logger.info('Removed bypass token');
  }
  
  /**
   * Get client IP address from request
   */
  private getClientIp(req: Request): string {
    // Try to get IP from headers if behind proxy
    const forwardedFor = req.headers['x-forwarded-for'];
    if (forwardedFor) {
      const ips = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
      return ips.split(',')[0].trim();
    }
    
    // Fallback to connection remote address
    return req.ip || '127.0.0.1';
  }
  
  /**
   * Get user tier for a user
   */
  private async getUserTier(userId: string): Promise<string> {
    try {
      const user = await this.userService.getUserById(userId);
      return user?.tier || 'free';
    } catch (error) {
      this.logger.error('Error getting user tier', { error, userId });
      return 'free';
    }
  }
  
  /**
   * Get rules that match the request
   */
  private getMatchingRules(req: Request, userTier: string): RateLimitRule[] {
    return this.rules.filter(rule => {
      // Check method
      if (rule.method) {
        const methods = Array.isArray(rule.method) ? rule.method : [rule.method];
        if (!methods.includes(req.method)) {
          return false;
        }
      }
      
      // Check path
      if (!this.matchPath(rule.path, req.path)) {
        return false;
      }
      
      // Check user tier if specified
      if (rule.userTier) {
        const tiers = Array.isArray(rule.userTier) ? rule.userTier : [rule.userTier];
        if (!tiers.includes(userTier)) {
          return false;
        }
      }
      
      return true;
    });
  }
  
  /**
   * Match request path to rule path pattern
   */
  private matchPath(rulePath: string, requestPath: string): boolean {
    // Exact match
    if (rulePath === requestPath) {
      return true;
    }
    
    // Regex match
    let pathRegex = this.pathRegexCache.get(rulePath);
    if (!pathRegex) {
      // Convert path pattern to regex
      const regexPattern = rulePath
        .replace(/\*/g, '.*')
        .replace(/:([a-zA-Z0-9_]+)/g, '([^/]+)');
      
      pathRegex = new RegExp(`^${regexPattern}$`);
      this.pathRegexCache.set(rulePath, pathRegex);
    }
    
    return pathRegex.test(requestPath);
  }
  
  /**
   * Check if request passes a specific rate limit rule
   */
  private async checkRateLimitRule(
    identifier: string,
    rule: RateLimitRule
  ): Promise<boolean> {
    const now = Math.floor(Date.now() / 1000);
    const key = `ratelimit:${identifier}`;
    
    // Get current state from Redis
    const stateJson = await this.redis.get(key);
    let state: RateLimitState;
    
    if (stateJson) {
      state = JSON.parse(stateJson);
      
      // Check if window has expired
      if (now >= state.resetTime) {
        // Reset for new window
        state = {
          counter: 0,
          resetTime: now + rule.window,
          lastUpdated: now
        };
      }
    } else {
      // Initialize new state
      state = {
        counter: 0,
        resetTime: now + rule.window,
        lastUpdated: now
      };
    }
    
    // Check if limit is exceeded
    const weight = rule.weight || 1;
    if (state.counter + weight > rule.limit) {
      // Log the rate limit hit
      this.logger.warn('Rate limit exceeded', {
        identifier,
        rule: rule.id,
        counter: state.counter,
        limit: rule.limit
      });
      
      return false;
    }
    
    // Increment counter
    state.counter += weight;
    state.lastUpdated = now;
    
    // Save state back to Redis
    await this.redis.set(key, JSON.stringify(state), 'EX', rule.window);
    
    return true;
  }
  
  /**
   * Check default rate limits based on user tier
   */
  private async checkDefaultLimits(
    userId: string,
    clientIp: string,
    userTier: string
  ): Promise<boolean> {
    // Get tier configuration
    const tier = this.userTiers.find(t => t.id === userTier) || {
      id: 'anonymous',
      name: 'Anonymous',
      limits: this.defaultLimits,
      priority: 0
    };
    
    const identifier = userId === 'anonymous' ? clientIp : userId;
    const now = Math.floor(Date.now() / 1000);
    
    // Check each time window
    const checks = [
      {
        window: 1, // per second
        limit: tier.limits.requestsPerSecond,
        key: `ratelimit:${identifier}:1s`
      },
      {
        window: 60, // per minute
        limit: tier.limits.requestsPerMinute,
        key: `ratelimit:${identifier}:1m`
      },
      {
        window: 3600, // per hour
        limit: tier.limits.requestsPerHour,
        key: `ratelimit:${identifier}:1h`
      },
      {
        window: 86400, // per day
        limit: tier.limits.requestsPerDay,
        key: `ratelimit:${identifier}:1d`
      }
    ];
    
    for (const check of checks) {
      // Get current state from Redis
      const stateJson = await this.redis.get(check.key);
      let state: RateLimitState;
      
      if (stateJson) {
        state = JSON.parse(stateJson);
        
        // Check if window has expired
        if (now >= state.resetTime) {
          // Reset for new window
          state = {
            counter: 1, // Count this request
            resetTime: now + check.window,
            lastUpdated: now
          };
        } else {
          // Increment counter
          state.counter += 1;
          state.lastUpdated = now;
          
          // Check if limit is exceeded
          if (state.counter > check.limit) {
            this.logger.warn('Default rate limit exceeded', {
              identifier,
              userTier,
              window: check.window,
              counter: state.counter,
              limit: check.limit
            });
            
            return false;
          }
        }
      } else {
        // Initialize new state
        state = {
          counter: 1, // Count this request
          resetTime: now + check.window,
          lastUpdated: now
        };
      }
      
      // Save state back to Redis
      await this.redis.set(check.key, JSON.stringify(state), 'EX', check.window);
    }
    
    return true;
  }
  
  /**
   * Send rate limit error response
   */
  private sendRateLimitError(res: Response, message: string): void {
    res.status(429).json({
      status: 'error',
      error: 'Too Many Requests',
      message
    });
  }
  
  /**
   * Load rate limit rules from configuration
   */
  private async loadRules(): Promise<void> {
    try {
      const rules = await this.configService.getConfig<RateLimitRule[]>('rate-limits');
      if (rules) {
        this.rules = rules;
        
        // Sort rules by priority (higher first)
        this.rules.sort((a, b) => b.priority - a.priority);
        
        // Clear regex cache
        this.pathRegexCache.clear();
        
        this.logger.info('Loaded rate limit rules', { count: this.rules.length });
      } else {
        this.rules = [];
        this.logger.info('No rate limit rules found');
      }
    } catch (error) {
      this.logger.error('Error loading rate limit rules', { error });
      this.rules = [];
    }
  }
  
  /**
   * Load user tiers from configuration
   */
  private async loadUserTiers(): Promise<void> {
    try {
      const tiers = await this.configService.getConfig<UserTier[]>('user-tiers');
      if (tiers) {
        this.userTiers = tiers;
        
        // Sort tiers by priority (higher first)
        this.userTiers.sort((a, b) => b.priority - a.priority);
        
        this.logger.info('Loaded user tiers', { count: this.userTiers.length });
      } else {
        // Create default tiers
        this.userTiers = [
          {
            id: 'anonymous',
            name: 'Anonymous',
            limits: {
              requestsPerSecond: 5,
              requestsPerMinute: 30,
              requestsPerHour: 100,
              requestsPerDay: 1000,
              burstCapacity: 10
            },
            priority: 0
          },
          {
            id: 'free',
            name: 'Free Tier',
            limits: {
              requestsPerSecond: 10,
              requestsPerMinute: 100,
              requestsPerHour: 1000,
              requestsPerDay: 10000,
              burstCapacity: 20
            },
            priority: 10
          },
          {
            id: 'premium',
            name: 'Premium Tier',
            limits: {
              requestsPerSecond: 50,
              requestsPerMinute: 500,
              requestsPerHour: 5000,
              requestsPerDay: 50000,
              burstCapacity: 100
            },
            priority: 20
          },
          {
            id: 'enterprise',
            name: 'Enterprise Tier',
            limits: {
              requestsPerSecond: 100,
              requestsPerMinute: 1000,
              requestsPerHour: 10000,
              requestsPerDay: 100000,
              burstCapacity: 200
            },
            priority: 30
          }
        ];
        
        // Save default tiers
        await this.configService.saveConfig('user-tiers', this.userTiers);
        this.logger.info('Created default user tiers', { count: this.userTiers.length });
      }
    } catch (error) {
      this.logger.error('Error loading user tiers', { error });
      this.userTiers = [];
    }
  }
  
  /**
   * Load bypass tokens from configuration
   */
  private async loadBypassTokens(): Promise<void> {
    try {
      const tokens = await this.configService.getConfig<string[]>('bypass-tokens');
      if (tokens) {
        this.bypassTokens = new Set(tokens);
        this.logger.info('Loaded bypass tokens', { count: this.bypassTokens.size });
      } else {
        this.bypassTokens = new Set();
        this.logger.info('No bypass tokens found');
      }
    } catch (error) {
      this.logger.error('Error loading bypass tokens', { error });
      this.bypassTokens = new Set();
    }
  }
}