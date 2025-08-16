import { NanoTimestampConverter } from '../utils/NanoTimestampConverter';
import { OrderBookUpdate, OrderUpdate, TradeUpdate } from '../types/marketData';
import { VenueConfig } from '../config/venueConfig';
import { SymbolMapper } from './SymbolMapper';
import { Logger } from '../utils/Logger';

export class DataNormalizer {
  private logger: Logger;
  private symbolMapper: SymbolMapper;
  private venueConfigs: Map<string, VenueConfig>;
  private timestampConverter: NanoTimestampConverter;
  
  constructor(venueConfigs: Map<string, VenueConfig>) {
    this.logger = new Logger('DataNormalizer');
    this.symbolMapper = new SymbolMapper();
    this.venueConfigs = venueConfigs;
    this.timestampConverter = new NanoTimestampConverter();
  }
  
  public process(data: OrderBookUpdate | OrderUpdate | TradeUpdate): OrderBookUpdate | OrderUpdate | TradeUpdate {
    try {
      // 1. Normalize timestamps to nanosecond precision
      data = this.normalizeTimestamp(data);
      
      // 2. Normalize symbol representation
      data = this.normalizeSymbol(data);
      
      // 3. Normalize prices based on venue tick size
      if ('price' in data) {
        data.price = this.normalizePrice(data.venue, data.symbol, data.price);
      }
      
      // 4. Normalize quantities based on venue lot size
      if ('quantity' in data) {
        data.quantity = this.normalizeQuantity(data.venue, data.symbol, data.quantity);
      }
      
      // 5. Add metadata and enrichment
      data = this.enrichData(data);
      
      return data;
    } catch (error) {
      this.logger.error(`Normalization error: ${error}`);
      throw error;
    }
  }
  
  private normalizeTimestamp(data: any): any {
    // Convert all timestamps to nanosecond precision in UTC
    if (data.timestamp) {
      data.originalTimestamp = data.timestamp;
      data.timestamp = this.timestampConverter.toNanoseconds(data.timestamp, data.venue);
    }
    
    // Add received timestamp if not present
    if (!data.receivedTimestamp) {
      data.receivedTimestamp = this.timestampConverter.getCurrentNanosTimestamp();
    }
    
    return data;
  }
  
  private normalizeSymbol(data: any): any {
    if (data.symbol) {
      data.originalSymbol = data.symbol;
      data.symbol = this.symbolMapper.toCanonical(data.venue, data.symbol);
    }
    return data;
  }
  
  private normalizePrice(venue: string, symbol: string, price: number): number {
    const venueConfig = this.venueConfigs.get(venue);
    if (!venueConfig) return price;
    
    const tickSize = venueConfig.getTickSize(symbol);
    if (!tickSize) return price;
    
    // Round to the nearest tick size
    return Math.round(price / tickSize) * tickSize;
  }
  
  private normalizeQuantity(venue: string, symbol: string, quantity: number): number {
    const venueConfig = this.venueConfigs.get(venue);
    if (!venueConfig) return quantity;
    
    const lotSize = venueConfig.getLotSize(symbol);
    if (!lotSize) return quantity;
    
    // Round to the nearest lot size
    return Math.round(quantity / lotSize) * lotSize;
  }
  
  private enrichData(data: any): any {
    // Add metadata based on venue-specific characteristics
    if (data.venue && data.participantType === undefined) {
      // Try to infer participant type from venue-specific data
      data.participantType = this.inferParticipantType(data);
    }
    
    // Add cross-venue identifiers
    if (data.symbol) {
      data.assetClass = this.symbolMapper.getAssetClass(data.symbol);
      data.baseCurrency = this.symbolMapper.getBaseCurrency(data.symbol);
      data.quoteCurrency = this.symbolMapper.getQuoteCurrency(data.symbol);
    }
    
    return data;
  }
  
  private inferParticipantType(data: any): string | undefined {
    // Implement heuristics to categorize participant types
    // This is a placeholder for more sophisticated logic
    
    if (data.venue === 'BINANCE' && data.flags?.includes('MM')) {
      return 'MARKET_MAKER';
    }
    
    if (data.venue === 'NYSE' && data.mpid) {
      // Check against known MPIDs for classification
      return this.getMpidCategory(data.mpid);
    }
    
    return undefined;
  }
  
  private getMpidCategory(mpid: string): string | undefined {
    // Map known MPIDs to participant categories
    // This would be expanded with a comprehensive database
    const mpidMap: {[key: string]: string} = {
      'GSCO': 'INSTITUTIONAL',
      'MSCO': 'INSTITUTIONAL',
      'UBSS': 'INSTITUTIONAL',
      'KCGM': 'HFT',
      'VIRT': 'HFT',
      'NITE': 'RETAIL_WHOLESALER'
    };
    
    return mpidMap[mpid];
  }
}