import React, { useState, useEffect } from 'react';
import { OrderBook } from '../components/OrderBook';
import { DepthChart } from '../components/DepthChart';
import { TradeHistory } from '../components/TradeHistory';
import { DashboardLayout } from '../layouts/DashboardLayout';
import { VenueSelector } from '../components/VenueSelector';
import { InstrumentSearch } from '../components/InstrumentSearch';
import { useOrderBookData } from '../hooks/useOrderBookData';

export default function Dashboard() {
  const [selectedVenues, setSelectedVenues] = useState<string[]>(['BINANCE', 'COINBASE']);
  const [selectedInstrument, setSelectedInstrument] = useState<string>('BTC-USD');
  const { orderBookData, tradeData, isLoading, error } = useOrderBookData(
    selectedVenues, 
    selectedInstrument
  );

  return (
    <DashboardLayout>
      <div className="dashboard-controls">
        <VenueSelector 
          venues={['BINANCE', 'COINBASE', 'KRAKEN', 'NYSE', 'NASDAQ']} 
          selectedVenues={selectedVenues}
          onChange={setSelectedVenues}
        />
        <InstrumentSearch 
          onSelect={setSelectedInstrument} 
          current={selectedInstrument} 
        />
      </div>
      
      <div className="dashboard-grid">
        <div className="dashboard-item">
          <OrderBook 
            data={orderBookData} 
            isLoading={isLoading}
            error={error}
          />
        </div>
        <div className="dashboard-item">
          <DepthChart 
            data={orderBookData} 
            isLoading={isLoading}
          />
        </div>
        <div className="dashboard-item">
          <TradeHistory 
            data={tradeData}
            isLoading={isLoading} 
          />
        </div>
      </div>
    </DashboardLayout>
  );
}