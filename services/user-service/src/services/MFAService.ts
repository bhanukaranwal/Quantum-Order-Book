import * as crypto from 'crypto';
import * as speakeasy from 'speakeasy';
import * as qrcode from 'qrcode';
import { UserRepository } from '../repositories/UserRepository';
import { MFARepository } from '../repositories/MFARepository';
import { Logger } from '../utils/Logger';
import { ApiError } from '../errors/ApiError';
import { MFAMethod, MFAStatus, MFAType, MFAVerification } from '../types/MFA';

export class MFAService {
  private userRepository: UserRepository;
  private mfaRepository: MFARepository;
  private logger: Logger;
  private appName: string;

  constructor(
    userRepository: UserRepository,
    mfaRepository: MFARepository,
    appName = 'Quantum Order Book'
  ) {
    this.userRepository = userRepository;
    this.mfaRepository = mfaRepository;
    this.logger = new Logger('MFAService');
    this.appName = appName;
  }

  /**
   * Generate a new TOTP secret for a user
   */
  public async generateTOTPSecret(userId: string): Promise<{ secret: string; qrCodeUrl: string }> {
    try {
      const user = await this.userRepository.findById(userId);
      if (!user) {
        throw new ApiError('User not found', 404);
      }

      // Generate new secret
      const secret = speakeasy.generateSecret({
        length: 20,
        name: `${this.appName}:${user.email}`
      });

      // Store the secret temporarily (until verified)
      await this.mfaRepository.saveUnverifiedSecret(userId, {
        type: MFAType.TOTP,
        secret: secret.base32,
        createdAt: new Date()
      });

      // Generate QR code
      const qrCodeUrl = await qrcode.toDataURL(secret.otpauth_url || '');

      return {
        secret: secret.base32,
        qrCodeUrl
      };
    } catch (error) {
      this.logger.error(`Error generating TOTP secret: ${error.message}`);
      throw error;
    }
  }

  /**
   * Verify and enable TOTP for a user
   */
  public async verifyAndEnableTOTP(
    userId: string,
    token: string
  ): Promise<{ backupCodes: string[] }> {
    try {
      const user = await this.userRepository.findById(userId);
      if (!user) {
        throw new ApiError('User not found', 404);
      }

      // Get the unverified secret
      const unverifiedSecret = await this.mfaRepository.getUnverifiedSecret(userId);
      if (!unverifiedSecret || unverifiedSecret.type !== MFAType.TOTP) {
        throw new ApiError('No pending TOTP setup found', 400);
      }

      // Verify the token
      const verified = speakeasy.totp.verify({
        secret: unverifiedSecret.secret,
        encoding: 'base32',
        token,
        window: 1 // Allow a window of 1 step before and after the current time
      });

      if (!verified) {
        throw new ApiError('Invalid verification code', 400);
      }

      // Generate backup codes
      const backupCodes = this.generateBackupCodes();

      // Enable TOTP for the user
      await this.mfaRepository.enableMFA(userId, {
        type: MFAType.TOTP,
        secret: unverifiedSecret.secret,
        backupCodes: backupCodes.map(code => ({
          code: this.hashBackupCode(code),
          used: false
        })),
        createdAt: new Date(),
        lastUsedAt: null
      });

      // Update user MFA status
      await this.userRepository.updateMFAStatus(userId, MFAStatus.ENABLED);

      // Remove unverified secret
      await this.mfaRepository.removeUnverifiedSecret(userId);

      // Return plaintext backup codes to the user (this is the only time they'll see them)
      return { backupCodes };
    } catch (error) {
      this.logger.error(`Error verifying TOTP: ${error.message}`);
      throw error;
    }
  }

  /**
   * Verify a TOTP code during login
   */
  public async verifyTOTP(userId: string, token: string): Promise<boolean> {
    try {
      const mfaSettings = await this.mfaRepository.getMFASettings(userId);
      
      if (!mfaSettings || mfaSettings.type !== MFAType.TOTP) {
        throw new ApiError('TOTP not enabled for this user', 400);
      }

      // Verify the token
      const verified = speakeasy.totp.verify({
        secret: mfaSettings.secret,
        encoding: 'base32',
        token,
        window: 1
      });

      if (verified) {
        // Update last used timestamp
        await this.mfaRepository.updateLastUsed(userId);
        
        // Record successful verification
        await this.mfaRepository.recordVerification(userId, {
          type: MFAType.TOTP,
          method: MFAMethod.APP,
          success: true,
          timestamp: new Date(),
          ipAddress: null, // Would be provided in actual implementation
          userAgent: null  // Would be provided in actual implementation
        });
      } else {
        // Record failed verification
        await this.mfaRepository.recordVerification(userId, {
          type: MFAType.TOTP,
          method: MFAMethod.APP,
          success: false,
          timestamp: new Date(),
          ipAddress: null,
          userAgent: null
        });
      }

      return verified;
    } catch (error) {
      this.logger.error(`Error verifying TOTP: ${error.message}`);
      throw error;
    }
  }

  /**
   * Verify a backup code
   */
  public async verifyBackupCode(userId: string, code: string): Promise<boolean> {
    try {
      const mfaSettings = await this.mfaRepository.getMFASettings(userId);
      
      if (!mfaSettings || !mfaSettings.backupCodes) {
        throw new ApiError('MFA not enabled for this user', 400);
      }

      // Hash the provided code
      const hashedCode = this.hashBackupCode(code);

      // Find matching backup code
      const backupCodeEntry = mfaSettings.backupCodes.find(
        bc => bc.code === hashedCode && !bc.used
      );

      if (!backupCodeEntry) {
        // Record failed verification
        await this.mfaRepository.recordVerification(userId, {
          type: mfaSettings.type,
          method: MFAMethod.BACKUP_CODE,
          success: false,
          timestamp: new Date(),
          ipAddress: null,
          userAgent: null
        });
        
        return false;
      }

      // Mark the backup code as used
      await this.mfaRepository.markBackupCodeAsUsed(userId, hashedCode);
      
      // Update last used timestamp
      await this.mfaRepository.updateLastUsed(userId);
      
      // Record successful verification
      await this.mfaRepository.recordVerification(userId, {
        type: mfaSettings.type,
        method: MFAMethod.BACKUP_CODE,
        success: true,
        timestamp: new Date(),
        ipAddress: null,
        userAgent: null
      });

      return true;
    } catch (error) {
      this.logger.error(`Error verifying backup code: ${error.message}`);
      throw error;
    }
  }

  /**
   * Disable MFA for a user
   */
  public async disableMFA(userId: string, password: string): Promise<void> {
    try {
      const user = await this.userRepository.findById(userId);
      if (!user) {
        throw new ApiError('User not found', 404);
      }

      // In a real implementation, you'd verify the password here
      // const validPassword = await this.passwordService.verify(userId, password);
      // if (!validPassword) {
      //   throw new ApiError('Invalid password', 401);
      // }

      // Disable MFA for the user
      await this.mfaRepository.disableMFA(userId);
      
      // Update user MFA status
      await this.userRepository.updateMFAStatus(userId, MFAStatus.DISABLED);
    } catch (error) {
      this.logger.error(`Error disabling MFA: ${error.message}`);
      throw error;
    }
  }

  /**
   * Generate new backup codes for a user
   */
  public async regenerateBackupCodes(userId: string): Promise<string[]> {
    try {
      const mfaSettings = await this.mfaRepository.getMFASettings(userId);
      
      if (!mfaSettings) {
        throw new ApiError('MFA not enabled for this user', 400);
      }

      // Generate new backup codes
      const backupCodes = this.generateBackupCodes();

      // Update backup codes
      await this.mfaRepository.updateBackupCodes(userId, backupCodes.map(code => ({
        code: this.hashBackupCode(code),
        used: false
      })));

      // Return plaintext backup codes
      return backupCodes;
    } catch (error) {
      this.logger.error(`Error regenerating backup codes: ${error.message}`);
      throw error;
    }
  }

  /**
   * Check if a user has MFA enabled
   */
  public async isMFAEnabled(userId: string): Promise<boolean> {
    try {
      const user = await this.userRepository.findById(userId);
      if (!user) {
        throw new ApiError('User not found', 404);
      }

      return user.mfaStatus === MFAStatus.ENABLED;
    } catch (error) {
      this.logger.error(`Error checking MFA status: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get MFA method details for a user
   */
  public async getMFADetails(userId: string): Promise<{
    enabled: boolean;
    type?: MFAType;
    createdAt?: Date;
    lastUsedAt?: Date | null;
    backupCodesRemaining?: number;
  }> {
    try {
      const user = await this.userRepository.findById(userId);
      if (!user) {
        throw new ApiError('User not found', 404);
      }

      if (user.mfaStatus !== MFAStatus.ENABLED) {
        return { enabled: false };
      }

      const mfaSettings = await this.mfaRepository.getMFASettings(userId);
      
      if (!mfaSettings) {
        // This shouldn't happen if the user status is enabled
        await this.userRepository.updateMFAStatus(userId, MFAStatus.DISABLED);
        return { enabled: false };
      }

      return {
        enabled: true,
        type: mfaSettings.type,
        createdAt: mfaSettings.createdAt,
        lastUsedAt: mfaSettings.lastUsedAt,
        backupCodesRemaining: mfaSettings.backupCodes?.filter(bc => !bc.used).length || 0
      };
    } catch (error) {
      this.logger.error(`Error getting MFA details: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get verification history for a user
   */
  public async getVerificationHistory(
    userId: string, 
    limit = 10
  ): Promise<MFAVerification[]> {
    try {
      return await this.mfaRepository.getVerificationHistory(userId, limit);
    } catch (error) {
      this.logger.error(`Error getting verification history: ${error.message}`);
      throw error;
    }
  }

  /**
   * Generate random backup codes
   */
  private generateBackupCodes(count = 10, length = 8): string[] {
    const codes: string[] = [];
    
    for (let i = 0; i < count; i++) {
      // Generate a random code of specified length
      const code = crypto.randomBytes(Math.ceil(length / 2))
        .toString('hex')
        .slice(0, length)
        .toUpperCase();
        
      // Format as XXXX-XXXX
      const formattedCode = `${code.slice(0, 4)}-${code.slice(4)}`;
      
      codes.push(formattedCode);
    }
    
    return codes;
  }

  /**
   * Hash a backup code for secure storage
   */
  private hashBackupCode(code: string): string {
    // Remove formatting
    const normalizedCode = code.replace('-', '');
    
    // Hash the code
    return crypto
      .createHash('sha256')
      .update(normalizedCode)
      .digest('hex');
  }
}