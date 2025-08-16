import { Request, Response } from 'express';
import { UserService } from '../services/UserService';
import { TokenService } from '../services/TokenService';
import { AuditLogService } from '../services/AuditLogService';
import { validateLoginInput, validateRegistrationInput } from '../validators/authValidator';
import { ApiError } from '../errors/ApiError';
import { AuthEventEmitter } from '../events/AuthEventEmitter';
import { RateLimiter } from '../utils/RateLimiter';
import { IpGeolocationService } from '../services/IpGeolocationService';
import { TwoFactorService } from '../services/TwoFactorService';
import { UserRole } from '../types/User';

export class AuthController {
  private userService: UserService;
  private tokenService: TokenService;
  private auditLogService: AuditLogService;
  private eventEmitter: AuthEventEmitter;
  private rateLimiter: RateLimiter;
  private ipGeoService: IpGeolocationService;
  private twoFactorService: TwoFactorService;
  
  constructor(
    userService: UserService,
    tokenService: TokenService,
    auditLogService: AuditLogService,
    eventEmitter: AuthEventEmitter,
    rateLimiter: RateLimiter,
    ipGeoService: IpGeolocationService,
    twoFactorService: TwoFactorService
  ) {
    this.userService = userService;
    this.tokenService = tokenService;
    this.auditLogService = auditLogService;
    this.eventEmitter = eventEmitter;
    this.rateLimiter = rateLimiter;
    this.ipGeoService = ipGeoService;
    this.twoFactorService = twoFactorService;
  }
  
  /**
   * Register a new user
   */
  public async register(req: Request, res: Response): Promise<void> {
    try {
      // Validate input
      const { email, password, firstName, lastName } = validateRegistrationInput(req.body);
      
      // Check if user already exists
      const existingUser = await this.userService.findUserByEmail(email);
      if (existingUser) {
        throw new ApiError('User with this email already exists', 409);
      }
      
      // Create user
      const user = await this.userService.createUser({
        email,
        password,
        firstName,
        lastName,
        roles: [UserRole.USER],
        verified: false,
        preferences: {
          theme: 'dark',
          locale: req.headers['accept-language'] || 'en-US',
          timezone: 'UTC'
        }
      });
      
      // Generate verification token
      const verificationToken = await this.tokenService.generateEmailVerificationToken(user.id);
      
      // Emit event for email sending
      this.eventEmitter.emitUserRegistered({
        userId: user.id,
        email: user.email,
        name: `${user.firstName} ${user.lastName}`,
        verificationToken
      });
      
      // Audit log
      await this.auditLogService.logUserAction({
        userId: user.id,
        action: 'USER_REGISTERED',
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'] || '',
        details: {
          email: user.email
        }
      });
      
      res.status(201).json({
        message: 'User registered successfully. Please verify your email.',
        userId: user.id
      });
      
    } catch (error) {
      if (error instanceof ApiError) {
        res.status(error.statusCode).json({ error: error.message });
      } else {
        console.error('Registration error:', error);
        res.status(500).json({ error: 'Internal server error during registration' });
      }
    }
  }
  
  /**
   * Log in a user
   */
  public async login(req: Request, res: Response): Promise<void> {
    try {
      // Rate limiting check
      const rateLimitKey = `login:${req.ip}`;
      const rateLimited = await this.rateLimiter.checkLimit(rateLimitKey, 10, 60 * 15); // 10 attempts per 15 minutes
      
      if (rateLimited) {
        throw new ApiError('Too many login attempts. Please try again later.', 429);
      }
      
      // Validate input
      const { email, password, totpToken } = validateLoginInput(req.body);
      
      // Get user
      const user = await this.userService.findUserByEmail(email);
      if (!user) {
        await this.rateLimiter.increment(rateLimitKey);
        throw new ApiError('Invalid email or password', 401);
      }
      
      // Check if account is locked
      if (user.lockedUntil && new Date(user.lockedUntil) > new Date()) {
        throw new ApiError('Account is temporarily locked. Please try again later.', 403);
      }
      
      // Verify password
      const isPasswordValid = await this.userService.verifyPassword(user.id, password);
      if (!isPasswordValid) {
        await this.rateLimiter.increment(rateLimitKey);
        
        // Handle failed login attempts
        const updatedUser = await this.userService.recordFailedLoginAttempt(user.id);
        if (updatedUser.failedLoginAttempts >= 5) {
          // Lock account temporarily
          await this.userService.lockAccount(user.id, 30); // Lock for 30 minutes
          
          // Send notification about account lock
          this.eventEmitter.emitAccountLocked({
            userId: user.id,
            email: user.email,
            name: `${user.firstName} ${user.lastName}`
          });
        }
        
        throw new ApiError('Invalid email or password', 401);
      }
      
      // Check if email is verified
      if (!user.verified) {
        throw new ApiError('Email not verified. Please verify your email before logging in.', 403);
      }
      
      // Check 2FA if enabled
      if (user.twoFactorEnabled) {
        if (!totpToken) {
          res.status(200).json({
            requiresTwoFactor: true,
            message: 'Please provide 2FA token to complete login'
          });
          return;
        }
        
        const isValidTotp = await this.twoFactorService.verifyToken(user.id, totpToken);
        if (!isValidTotp) {
          await this.rateLimiter.increment(rateLimitKey);
          throw new ApiError('Invalid 2FA token', 401);
        }
      }
      
      // Reset failed login attempts
      await this.userService.resetFailedLoginAttempts(user.id);
      
      // Generate tokens
      const accessToken = this.tokenService.generateAccessToken(user);
      const refreshToken = await this.tokenService.generateRefreshToken(user.id);
      
      // Get location info for security
      const geoInfo = await this.ipGeoService.getLocationInfo(req.ip);
      
      // Check for unusual login location
      if (geoInfo && user.lastLoginCountry && geoInfo.countryCode !== user.lastLoginCountry) {
        // Send notification about new login location
        this.eventEmitter.emitUnusualLoginLocation({
          userId: user.id,
          email: user.email,
          name: `${user.firstName} ${user.lastName}`,
          location: {
            current: {
              country: geoInfo.country,
              city: geoInfo.city,
              ip: req.ip
            },
            previous: {
              country: user.lastLoginCountry
            }
          }
        });
      }
      
      // Update last login info
      await this.userService.updateLastLogin(user.id, {
        timestamp: new Date(),
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'] || '',
        country: geoInfo?.countryCode
      });
      
      // Audit log
      await this.auditLogService.logUserAction({
        userId: user.id,
        action: 'USER_LOGIN',
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'] || '',
        details: {
          location: geoInfo
        }
      });
      
      // Set refresh token as HTTP-only cookie
      res.cookie('refreshToken', refreshToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
      });
      
      // Return user info and access token
      res.status(200).json({
        accessToken,
        user: {
          id: user.id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          roles: user.roles,
          preferences: user.preferences
        }
      });
      
    } catch (error) {
      if (error instanceof ApiError) {
        res.status(error.statusCode).json({ error: error.message });
      } else {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Internal server error during login' });
      }
    }
  }
  
  /**
   * Refresh access token using refresh token
   */
  public async refreshToken(req: Request, res: Response): Promise<void> {
    try {
      // Get refresh token from cookies
      const refreshToken = req.cookies.refreshToken;
      
      if (!refreshToken) {
        throw new ApiError('Refresh token is required', 401);
      }
      
      // Verify refresh token
      const tokenData = await this.tokenService.verifyRefreshToken(refreshToken);
      
      // Get user
      const user = await this.userService.findUserById(tokenData.userId);
      if (!user) {
        throw new ApiError('User not found', 404);
      }
      
      // Generate new access token
      const newAccessToken = this.tokenService.generateAccessToken(user);
      
      // Generate new refresh token
      const newRefreshToken = await this.tokenService.rotateRefreshToken(refreshToken);
      
      // Set new refresh token as HTTP-only cookie
      res.cookie('refreshToken', newRefreshToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
      });
      
      res.status(200).json({
        accessToken: newAccessToken
      });
      
    } catch (error) {
      // Clear invalid refresh token
      res.clearCookie('refreshToken');
      
      if (error instanceof ApiError) {
        res.status(error.statusCode).json({ error: error.message });
      } else {
        console.error('Token refresh error:', error);
        res.status(500).json({ error: 'Internal server error during token refresh' });
      }
    }
  }
  
  /**
   * Log out a user
   */
  public async logout(req: Request, res: Response): Promise<void> {
    try {
      // Get refresh token from cookies
      const refreshToken = req.cookies.refreshToken;
      
      if (refreshToken) {
        // Invalidate refresh token
        await this.tokenService.revokeRefreshToken(refreshToken);
      }
      
      // Clear refresh token cookie
      res.clearCookie('refreshToken');
      
      // Get user ID from request (set by auth middleware)
      const userId = req.user?.id;
      
      if (userId) {
        // Audit log
        await this.auditLogService.logUserAction({
          userId,
          action: 'USER_LOGOUT',
          ipAddress: req.ip,
          userAgent: req.headers['user-agent'] || ''
        });
      }
      
      res.status(200).json({ message: 'Logged out successfully' });
      
    } catch (error) {
      console.error('Logout error:', error);
      res.status(500).json({ error: 'Internal server error during logout' });
    }
  }
  
  /**
   * Verify email address
   */
  public async verifyEmail(req: Request, res: Response): Promise<void> {
    try {
      const { token } = req.params;
      
      if (!token) {
        throw new ApiError('Verification token is required', 400);
      }
      
      // Verify token
      const tokenData = await this.tokenService.verifyEmailVerificationToken(token);
      
      // Mark user as verified
      await this.userService.markEmailAsVerified(tokenData.userId);
      
      // Audit log
      await this.auditLogService.logUserAction({
        userId: tokenData.userId,
        action: 'EMAIL_VERIFIED',
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'] || ''
      });
      
      // Redirect to login page with success message
      res.redirect(`${process.env.FRONTEND_URL}/login?verified=true`);
      
    } catch (error) {
      console.error('Email verification error:', error);
      
      // Redirect to error page
      res.redirect(`${process.env.FRONTEND_URL}/verification-error`);
    }
  }
  
  /**
   * Initialize 2FA setup
   */
  public async initiateTwoFactorSetup(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.user?.id;
      
      if (!userId) {
        throw new ApiError('Unauthorized', 401);
      }
      
      // Get user
      const user = await this.userService.findUserById(userId);
      if (!user) {
        throw new ApiError('User not found', 404);
      }
      
      // Generate 2FA secret
      const { secret, qrCodeUrl } = await this.twoFactorService.generateSecret(
        user.id,
        user.email
      );
      
      res.status(200).json({
        secret,
        qrCodeUrl
      });
      
    } catch (error) {
      if (error instanceof ApiError) {
        res.status(error.statusCode).json({ error: error.message });
      } else {
        console.error('2FA setup error:', error);
        res.status(500).json({ error: 'Internal server error during 2FA setup' });
      }
    }
  }
  
  /**
   * Verify and enable 2FA
   */
  public async verifyAndEnableTwoFactor(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.user?.id;
      
      if (!userId) {
        throw new ApiError('Unauthorized', 401);
      }
      
      const { token, secret } = req.body;
      
      if (!token || !secret) {
        throw new ApiError('Token and secret are required', 400);
      }
      
      // Verify token with secret
      const isValid = await this.twoFactorService.verifyAndEnableToken(userId, secret, token);
      
      if (!isValid) {
        throw new ApiError('Invalid 2FA token', 401);
      }
      
      // Generate backup codes
      const backupCodes = await this.twoFactorService.generateBackupCodes(userId);
      
      // Audit log
      await this.auditLogService.logUserAction({
        userId,
        action: 'TWO_FACTOR_ENABLED',
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'] || ''
      });
      
      res.status(200).json({
        message: '2FA enabled successfully',
        backupCodes
      });
      
    } catch (error) {
      if (error instanceof ApiError) {
        res.status(error.statusCode).json({ error: error.message });
      } else {
        console.error('2FA verification error:', error);
        res.status(500).json({ error: 'Internal server error during 2FA verification' });
      }
    }
  }
  
  /**
   * Disable 2FA
   */
  public async disableTwoFactor(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.user?.id;
      
      if (!userId) {
        throw new ApiError('Unauthorized', 401);
      }
      
      const { password } = req.body;
      
      if (!password) {
        throw new ApiError('Password is required', 400);
      }
      
      // Verify password
      const isPasswordValid = await this.userService.verifyPassword(userId, password);
      if (!isPasswordValid) {
        throw new ApiError('Invalid password', 401);
      }
      
      // Disable 2FA
      await this.twoFactorService.disableTwoFactor(userId);
      
      // Audit log
      await this.auditLogService.logUserAction({
        userId,
        action: 'TWO_FACTOR_DISABLED',
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'] || ''
      });
      
      res.status(200).json({
        message: '2FA disabled successfully'
      });
      
    } catch (error) {
      if (error instanceof ApiError) {
        res.status(error.statusCode).json({ error: error.message });
      } else {
        console.error('2FA disable error:', error);
        res.status(500).json({ error: 'Internal server error during 2FA disabling' });
      }
    }
  }
}