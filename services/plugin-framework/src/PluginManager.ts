import { PluginConfig, PluginManifest, PluginMetadata, PluginStatus } from './types/Plugin';
import { PluginRegistry } from './registry/PluginRegistry';
import { PluginSandbox } from './sandbox/PluginSandbox';
import { PluginValidator } from './validation/PluginValidator';
import { PluginStorage } from './storage/PluginStorage';
import { EventBus } from './events/EventBus';
import { Logger } from './utils/Logger';
import { PluginPermissions } from './security/PluginPermissions';
import * as fs from 'fs-extra';
import * as path from 'path';
import { createHash } from 'crypto';

export class PluginManager {
  private registry: PluginRegistry;
  private sandbox: PluginSandbox;
  private validator: PluginValidator;
  private storage: PluginStorage;
  private eventBus: EventBus;
  private logger: Logger;
  private permissions: PluginPermissions;
  private pluginsDir: string;
  private activePlugins: Map<string, any>;
  
  constructor(
    registry: PluginRegistry,
    sandbox: PluginSandbox,
    validator: PluginValidator,
    storage: PluginStorage,
    eventBus: EventBus,
    permissions: PluginPermissions,
    pluginsDir: string
  ) {
    this.registry = registry;
    this.sandbox = sandbox;
    this.validator = validator;
    this.storage = storage;
    this.eventBus = eventBus;
    this.permissions = permissions;
    this.pluginsDir = pluginsDir;
    this.logger = new Logger('PluginManager');
    this.activePlugins = new Map();
    
    // Subscribe to system events
    this.eventBus.subscribe('system:shutdown', this.shutdownAllPlugins.bind(this));
  }
  
  /**
   * Install a plugin from a file or URL
   */
  public async installPlugin(source: string, options: { userId: string, overwrite?: boolean } = { userId: 'system' }): Promise<PluginMetadata> {
    try {
      this.logger.info(`Installing plugin from ${source}`);
      
      // 1. Download/copy plugin to temporary location
      const tempDir = await this.storage.createTempDirectory();
      const pluginFiles = await this.storage.extractPlugin(source, tempDir);
      
      // 2. Load and validate manifest
      const manifestPath = path.join(tempDir, 'manifest.json');
      if (!fs.existsSync(manifestPath)) {
        throw new Error(`Plugin manifest not found at ${manifestPath}`);
      }
      
      const manifest: PluginManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      
      // 3. Validate plugin structure and code
      const validationResult = await this.validator.validatePlugin(tempDir, manifest);
      if (!validationResult.valid) {
        throw new Error(`Plugin validation failed: ${validationResult.errors.join(', ')}`);
      }
      
      // 4. Check if plugin already exists
      const existingPlugin = await this.registry.getPlugin(manifest.id);
      if (existingPlugin && !options.overwrite) {
        throw new Error(`Plugin with ID ${manifest.id} already exists. Use overwrite option to replace it.`);
      }
      
      // 5. Calculate plugin checksum for integrity verification
      const mainScriptPath = path.join(tempDir, manifest.main);
      const fileBuffer = fs.readFileSync(mainScriptPath);
      const hashSum = createHash('sha256');
      const checksum = hashSum.update(fileBuffer).digest('hex');
      
      // 6. Prepare plugin metadata
      const pluginMeta: PluginMetadata = {
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        author: manifest.author,
        homepage: manifest.homepage,
        repository: manifest.repository,
        license: manifest.license,
        main: manifest.main,
        dependencies: manifest.dependencies || {},
        permissions: manifest.permissions || [],
        hooks: manifest.hooks || [],
        apiVersion: manifest.apiVersion,
        status: PluginStatus.INSTALLED,
        installDate: new Date().toISOString(),
        lastUpdated: new Date().toISOString(),
        installedBy: options.userId,
        checksum,
        configSchema: manifest.configSchema
      };
      
      // 7. Move plugin to plugins directory
      const pluginDir = path.join(this.pluginsDir, manifest.id);
      await fs.ensureDir(pluginDir);
      await fs.emptyDir(pluginDir); // Clear existing content if overwriting
      await fs.copy(tempDir, pluginDir);
      
      // 8. Create default configuration if provided
      if (manifest.defaultConfig) {
        await this.storage.savePluginConfig(manifest.id, manifest.defaultConfig);
      }
      
      // 9. Register plugin in the database
      await this.registry.registerPlugin(pluginMeta);
      
      // 10. Clean up temporary directory
      await fs.remove(tempDir);
      
      // 11. Emit plugin installed event
      this.eventBus.publish('plugin:installed', {
        pluginId: manifest.id,
        userId: options.userId
      });
      
      this.logger.info(`Plugin ${manifest.id} installed successfully`);
      
      return pluginMeta;
    } catch (error) {
      this.logger.error(`Failed to install plugin: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Load and activate a plugin
   */
  public async activatePlugin(pluginId: string, userId: string): Promise<void> {
    try {
      this.logger.info(`Activating plugin ${pluginId}`);
      
      // 1. Get plugin metadata from registry
      const pluginMeta = await this.registry.getPlugin(pluginId);
      if (!pluginMeta) {
        throw new Error(`Plugin ${pluginId} not found`);
      }
      
      // 2. Check if plugin is already active
      if (this.activePlugins.has(pluginId)) {
        this.logger.warn(`Plugin ${pluginId} is already active`);
        return;
      }
      
      // 3. Check plugin dependencies
      await this.checkDependencies(pluginMeta);
      
      // 4. Verify plugin integrity
      await this.verifyPluginIntegrity(pluginMeta);
      
      // 5. Check permissions
      const permissionGranted = await this.permissions.checkPermissions(pluginMeta, userId);
      if (!permissionGranted) {
        throw new Error(`Permission denied for plugin ${pluginId}`);
      }
      
      // 6. Load plugin configuration
      const config = await this.storage.loadPluginConfig(pluginId);
      
      // 7. Create sandbox environment for the plugin
      const pluginDir = path.join(this.pluginsDir, pluginId);
      const pluginMainPath = path.join(pluginDir, pluginMeta.main);
      
      // 8. Load plugin in sandbox
      const pluginInstance = await this.sandbox.loadPlugin(pluginMainPath, {
        pluginId,
        pluginDir,
        config,
        permissions: pluginMeta.permissions
      });
      
      // 9. Initialize plugin
      if (typeof pluginInstance.initialize === 'function') {
        await pluginInstance.initialize(config);
      }
      
      // 10. Register plugin hooks
      this.registerPluginHooks(pluginId, pluginInstance, pluginMeta.hooks);
      
      // 11. Update plugin status
      await this.registry.updatePluginStatus(pluginId, PluginStatus.ACTIVE);
      
      // 12. Store active plugin instance
      this.activePlugins.set(pluginId, pluginInstance);
      
      // 13. Emit plugin activated event
      this.eventBus.publish('plugin:activated', {
        pluginId,
        userId
      });
      
      this.logger.info(`Plugin ${pluginId} activated successfully`);
    } catch (error) {
      this.logger.error(`Failed to activate plugin ${pluginId}: ${error.message}`);
      
      // Update plugin status to error
      await this.registry.updatePluginStatus(pluginId, PluginStatus.ERROR, error.message);
      
      throw error;
    }
  }
  
  /**
   * Deactivate a plugin
   */
  public async deactivatePlugin(pluginId: string, userId: string): Promise<void> {
    try {
      this.logger.info(`Deactivating plugin ${pluginId}`);
      
      // 1. Check if plugin is active
      if (!this.activePlugins.has(pluginId)) {
        this.logger.warn(`Plugin ${pluginId} is not active`);
        return;
      }
      
      // 2. Get plugin instance
      const pluginInstance = this.activePlugins.get(pluginId);
      
      // 3. Call plugin shutdown method if available
      if (typeof pluginInstance.shutdown === 'function') {
        await pluginInstance.shutdown();
      }
      
      // 4. Unregister plugin hooks
      this.unregisterPluginHooks(pluginId);
      
      // 5. Remove from active plugins
      this.activePlugins.delete(pluginId);
      
      // 6. Update plugin status
      await this.registry.updatePluginStatus(pluginId, PluginStatus.INSTALLED);
      
      // 7. Emit plugin deactivated event
      this.eventBus.publish('plugin:deactivated', {
        pluginId,
        userId
      });
      
      this.logger.info(`Plugin ${pluginId} deactivated successfully`);
    } catch (error) {
      this.logger.error(`Failed to deactivate plugin ${pluginId}: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Uninstall a plugin
   */
  public async uninstallPlugin(pluginId: string, userId: string): Promise<void> {
    try {
      this.logger.info(`Uninstalling plugin ${pluginId}`);
      
      // 1. Deactivate plugin if active
      if (this.activePlugins.has(pluginId)) {
        await this.deactivatePlugin(pluginId, userId);
      }
      
      // 2. Get plugin metadata
      const pluginMeta = await this.registry.getPlugin(pluginId);
      if (!pluginMeta) {
        throw new Error(`Plugin ${pluginId} not found`);
      }
      
      // 3. Check if other plugins depend on this one
      const dependentPlugins = await this.registry.findDependentPlugins(pluginId);
      if (dependentPlugins.length > 0) {
        const dependentNames = dependentPlugins.map(p => p.name).join(', ');
        throw new Error(`Cannot uninstall plugin ${pluginId} because the following plugins depend on it: ${dependentNames}`);
      }
      
      // 4. Remove plugin files
      const pluginDir = path.join(this.pluginsDir, pluginId);
      if (fs.existsSync(pluginDir)) {
        await fs.remove(pluginDir);
      }
      
      // 5. Remove plugin configuration
      await this.storage.deletePluginConfig(pluginId);
      
      // 6. Unregister plugin from registry
      await this.registry.unregisterPlugin(pluginId);
      
      // 7. Emit plugin uninstalled event
      this.eventBus.publish('plugin:uninstalled', {
        pluginId,
        userId
      });
      
      this.logger.info(`Plugin ${pluginId} uninstalled successfully`);
    } catch (error) {
      this.logger.error(`Failed to uninstall plugin ${pluginId}: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Update plugin configuration
   */
  public async updatePluginConfig(pluginId: string, config: any, userId: string): Promise<void> {
    try {
      this.logger.info(`Updating configuration for plugin ${pluginId}`);
      
      // 1. Get plugin metadata
      const pluginMeta = await this.registry.getPlugin(pluginId);
      if (!pluginMeta) {
        throw new Error(`Plugin ${pluginId} not found`);
      }
      
      // 2. Validate configuration against schema if available
      if (pluginMeta.configSchema) {
        const validationResult = await this.validator.validateConfig(config, pluginMeta.configSchema);
        if (!validationResult.valid) {
          throw new Error(`Invalid configuration: ${validationResult.errors.join(', ')}`);
        }
      }
      
      // 3. Save configuration
      await this.storage.savePluginConfig(pluginId, config);
      
      // 4. If plugin is active, notify it of configuration change
      if (this.activePlugins.has(pluginId)) {
        const pluginInstance = this.activePlugins.get(pluginId);
        if (typeof pluginInstance.onConfigUpdate === 'function') {
          await pluginInstance.onConfigUpdate(config);
        }
      }
      
      // 5. Emit configuration updated event
      this.eventBus.publish('plugin:configUpdated', {
        pluginId,
        userId
      });
      
      this.logger.info(`Configuration for plugin ${pluginId} updated successfully`);
    } catch (error) {
      this.logger.error(`Failed to update configuration for plugin ${pluginId}: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Get all registered plugins
   */
  public async getPlugins(): Promise<PluginMetadata[]> {
    return this.registry.getAllPlugins();
  }
  
  /**
   * Get plugin metadata
   */
  public async getPlugin(pluginId: string): Promise<PluginMetadata | null> {
    return this.registry.getPlugin(pluginId);
  }
  
  /**
   * Check if a plugin is active
   */
  public isPluginActive(pluginId: string): boolean {
    return this.activePlugins.has(pluginId);
  }
  
  /**
   * Get plugin configuration
   */
  public async getPluginConfig(pluginId: string): Promise<any> {
    return this.storage.loadPluginConfig(pluginId);
  }
  
  /**
   * Get active plugin instance
   */
  public getPluginInstance(pluginId: string): any | null {
    return this.activePlugins.get(pluginId) || null;
  }
  
  /**
   * Check plugin dependencies
   */
  private async checkDependencies(plugin: PluginMetadata): Promise<void> {
    if (!plugin.dependencies || Object.keys(plugin.dependencies).length === 0) {
      return;
    }
    
    for (const [depId, versionReq] of Object.entries(plugin.dependencies)) {
      const dependency = await this.registry.getPlugin(depId);
      
      if (!dependency) {
        throw new Error(`Missing dependency: ${depId}`);
      }
      
      if (!this.validator.checkVersionCompatibility(dependency.version, versionReq)) {
        throw new Error(`Incompatible dependency version: ${depId} requires ${versionReq}, but found ${dependency.version}`);
      }
      
      // Ensure the dependency is active
      if (!this.isPluginActive(depId)) {
        throw new Error(`Dependency ${depId} is not active`);
      }
    }
  }
  
  /**
   * Verify plugin integrity by checking the file checksum
   */
  private async verifyPluginIntegrity(plugin: PluginMetadata): Promise<void> {
    const pluginDir = path.join(this.pluginsDir, plugin.id);
    const mainScriptPath = path.join(pluginDir, plugin.main);
    
    if (!fs.existsSync(mainScriptPath)) {
      throw new Error(`Plugin main script not found at ${mainScriptPath}`);
    }
    
    const fileBuffer = fs.readFileSync(mainScriptPath);
    const hashSum = createHash('sha256');
    const checksum = hashSum.update(fileBuffer).digest('hex');
    
    if (checksum !== plugin.checksum) {
      throw new Error(`Plugin integrity check failed for ${plugin.id}. File may have been modified.`);
    }
  }
  
  /**
   * Register plugin hooks with the event bus
   */
  private registerPluginHooks(pluginId: string, pluginInstance: any, hooks: string[]): void {
    if (!hooks || hooks.length === 0) {
      return;
    }
    
    for (const hook of hooks) {
      if (typeof pluginInstance[hook] === 'function') {
        this.eventBus.subscribe(hook, async (...args: any[]) => {
          try {
            return await pluginInstance[hook](...args);
          } catch (error) {
            this.logger.error(`Error in plugin ${pluginId} hook ${hook}: ${error.message}`);
            return null;
          }
        }, pluginId);
      }
    }
  }
  
  /**
   * Unregister all hooks for a plugin
   */
  private unregisterPluginHooks(pluginId: string): void {
    this.eventBus.unsubscribeAll(pluginId);
  }
  
  /**
   * Shutdown all active plugins
   */
  private async shutdownAllPlugins(): Promise<void> {
    this.logger.info('Shutting down all plugins');
    
    const pluginIds = Array.from(this.activePlugins.keys());
    
    for (const pluginId of pluginIds) {
      try {
        await this.deactivatePlugin(pluginId, 'system');
      } catch (error) {
        this.logger.error(`Error shutting down plugin ${pluginId}: ${error.message}`);
      }
    }
    
    this.logger.info('All plugins shut down');
  }
}