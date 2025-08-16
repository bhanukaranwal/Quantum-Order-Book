import React, { useEffect, useRef, useState, useMemo } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
import { mergeBufferGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils';
import { useTheme } from '../../hooks/useTheme';
import { Button, IconButton } from '../common/Button';
import { Spinner } from '../common/Spinner';
import { formatPrice, formatQuantity } from '../../utils/formatters';

interface OrderLevel {
  price: number;
  quantity: number;
  total: number;
  count: number;
}

interface OrderBookData {
  bids: OrderLevel[];
  asks: OrderLevel[];
  timestamp: number;
  spread: number;
  midPrice: number;
  venue: string;
  symbol: string;
}

interface OrderBookTerrain3DProps {
  data: OrderBookData;
  width?: number;
  height?: number;
  depth?: number;
  isLoading?: boolean;
  error?: string | null;
  onSymbolClick?: (symbol: string, venue: string) => void;
  showLabels?: boolean;
  showWireframe?: boolean;
  enableAnimation?: boolean;
  smoothUpdate?: boolean;
}

export const OrderBookTerrain3D: React.FC<OrderBookTerrain3DProps> = ({
  data,
  width = 800,
  height = 600,
  depth = 20,
  isLoading = false,
  error = null,
  onSymbolClick,
  showLabels = true,
  showWireframe = false,
  enableAnimation = true,
  smoothUpdate = true
}) => {
  const { colors, isDarkMode } = useTheme();
  const mountRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const bidsMeshRef = useRef<THREE.Mesh | null>(null);
  const asksMeshRef = useRef<THREE.Mesh | null>(null);
  const spreadMeshRef = useRef<THREE.Mesh | null>(null);
  const raycasterRef = useRef<THREE.Raycaster>(new THREE.Raycaster());
  const mouseRef = useRef<THREE.Vector2>(new THREE.Vector2());
  const frameIdRef = useRef<number | null>(null);
  const previousDataRef = useRef<OrderBookData | null>(null);
  const animationTimeRef = useRef<number>(0);
  const [hoveredPoint, setHoveredPoint] = useState<{
    price: number;
    quantity: number;
    side: 'bid' | 'ask';
    index: number;
  } | null>(null);
  const [viewMode, setViewMode] = useState<'3d' | 'top'>('3d');
  const [isPaused, setIsPaused] = useState<boolean>(false);
  
  // Calculate the max values for scaling
  const maxValues = useMemo(() => {
    if (!data) return { maxQuantity: 1, maxTotal: 1, priceRange: 1 };
    
    const maxBidQuantity = Math.max(...data.bids.map(level => level.quantity), 1);
    const maxAskQuantity = Math.max(...data.asks.map(level => level.quantity), 1);
    const maxQuantity = Math.max(maxBidQuantity, maxAskQuantity);
    
    const maxBidTotal = Math.max(...data.bids.map(level => level.total), 1);
    const maxAskTotal = Math.max(...data.asks.map(level => level.total), 1);
    const maxTotal = Math.max(maxBidTotal, maxAskTotal);
    
    const minPrice = Math.min(...data.bids.map(level => level.price));
    const maxPrice = Math.max(...data.asks.map(level => level.price));
    const priceRange = maxPrice - minPrice;
    
    return { maxQuantity, maxTotal, priceRange };
  }, [data]);
  
  // Initialize the 3D scene
  useEffect(() => {
    if (!mountRef.current) return;
    
    // Create scene
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(colors.chartBackground);
    sceneRef.current = scene;
    
    // Create camera
    const camera = new THREE.PerspectiveCamera(75, width / height, 0.1, 1000);
    camera.position.set(0, 20, 30);
    cameraRef.current = camera;
    
    // Create renderer
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.shadowMap.enabled = true;
    mountRef.current.appendChild(renderer.domElement);
    rendererRef.current = renderer;
    
    // Add controls
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.25;
    controls.rotateSpeed = 0.5;
    controls.maxPolarAngle = Math.PI / 2;
    controlsRef.current = controls;
    
    // Add lighting
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
    scene.add(ambientLight);
    
    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight.position.set(10, 20, 10);
    directionalLight.castShadow = true;
    directionalLight.shadow.mapSize.width = 2048;
    directionalLight.shadow.mapSize.height = 2048;
    scene.add(directionalLight);
    
    // Add grid helper
    const gridHelper = new THREE.GridHelper(50, 50, 0x555555, 0x333333);
    scene.add(gridHelper);
    
    // Add axes helper
    const axesHelper = new THREE.AxesHelper(5);
    scene.add(axesHelper);
    
    // Add event listener for mouse movement
    const handleMouseMove = (event: MouseEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      mouseRef.current.x = ((event.clientX - rect.left) / width) * 2 - 1;
      mouseRef.current.y = -((event.clientY - rect.top) / height) * 2 + 1;
    };
    
    renderer.domElement.addEventListener('mousemove', handleMouseMove);
    
    // Animation loop
    const animate = () => {
      frameIdRef.current = requestAnimationFrame(animate);
      
      if (controlsRef.current) {
        controlsRef.current.update();
      }
      
      // Perform raycasting for tooltips
      if (sceneRef.current && cameraRef.current) {
        raycasterRef.current.setFromCamera(mouseRef.current, cameraRef.current);
        
        // Check for intersections with bid and ask meshes
        const intersects: THREE.Intersection[] = [];
        
        if (bidsMeshRef.current) {
          intersects.push(...raycasterRef.current.intersectObject(bidsMeshRef.current));
        }
        
        if (asksMeshRef.current) {
          intersects.push(...raycasterRef.current.intersectObject(asksMeshRef.current));
        }
        
        if (intersects.length > 0) {
          const intersection = intersects[0];
          const faceIndex = intersection.faceIndex;
          
          if (faceIndex !== undefined) {
            const mesh = intersection.object as THREE.Mesh;
            const isBid = mesh === bidsMeshRef.current;
            const side = isBid ? 'bid' : 'ask';
            const levels = isBid ? data.bids : data.asks;
            
            // Calculate the level index from the face index
            // This depends on your geometry creation logic
            const levelIndex = Math.floor(faceIndex / 2);
            
            if (levels[levelIndex]) {
              setHoveredPoint({
                price: levels[levelIndex].price,
                quantity: levels[levelIndex].quantity,
                side,
                index: levelIndex
              });
            }
          }
        } else {
          setHoveredPoint(null);
        }
      }
      
      if (rendererRef.current && sceneRef.current && cameraRef.current) {
        rendererRef.current.render(sceneRef.current, cameraRef.current);
      }
    };
    
    animate();
    
    // Cleanup on unmount
    return () => {
      if (frameIdRef.current !== null) {
        cancelAnimationFrame(frameIdRef.current);
      }
      
      if (rendererRef.current && mountRef.current) {
        renderer.domElement.removeEventListener('mousemove', handleMouseMove);
        mountRef.current.removeChild(rendererRef.current.domElement);
      }
      
      // Dispose of resources
      if (sceneRef.current) {
        sceneRef.current.traverse((object) => {
          if (object instanceof THREE.Mesh) {
            if (object.geometry) object.geometry.dispose();
            
            if (object.material) {
              if (Array.isArray(object.material)) {
                object.material.forEach(material => material.dispose());
              } else {
                object.material.dispose();
              }
            }
          }
        });
      }
      
      if (rendererRef.current) {
        rendererRef.current.dispose();
      }
    };
  }, [width, height, colors.chartBackground]);
  
  // Update camera when view mode changes
  useEffect(() => {
    if (!cameraRef.current || !controlsRef.current) return;
    
    if (viewMode === 'top') {
      // Top-down view
      cameraRef.current.position.set(0, 40, 0);
      cameraRef.current.lookAt(0, 0, 0);
    } else {
      // 3D perspective view
      cameraRef.current.position.set(0, 20, 30);
      cameraRef.current.lookAt(0, 0, 0);
    }
    
    controlsRef.current.update();
  }, [viewMode]);
  
  // Create or update terrain geometry
  useEffect(() => {
    if (!sceneRef.current || !data || isPaused) return;
    
    // Store previous data for animations
    previousDataRef.current = previousDataRef.current || data;
    animationTimeRef.current = 0;
    
    // Function to create terrain geometry
    const createTerrain = (
      currentData: OrderBookData,
      previousData: OrderBookData | null,
      animationProgress: number = 1
    ) => {
      if (!sceneRef.current) return;
      
      // Remove previous meshes
      if (bidsMeshRef.current) {
        sceneRef.current.remove(bidsMeshRef.current);
        bidsMeshRef.current.geometry.dispose();
        if (Array.isArray(bidsMeshRef.current.material)) {
          bidsMeshRef.current.material.forEach(m => m.dispose());
        } else {
          bidsMeshRef.current.material.dispose();
        }
      }
      
      if (asksMeshRef.current) {
        sceneRef.current.remove(asksMeshRef.current);
        asksMeshRef.current.geometry.dispose();
        if (Array.isArray(asksMeshRef.current.material)) {
          asksMeshRef.current.material.forEach(m => m.dispose());
        } else {
          asksMeshRef.current.material.dispose();
        }
      }
      
      if (spreadMeshRef.current) {
        sceneRef.current.remove(spreadMeshRef.current);
        spreadMeshRef.current.geometry.dispose();
        if (Array.isArray(spreadMeshRef.current.material)) {
          spreadMeshRef.current.material.forEach(m => m.dispose());
        } else {
          spreadMeshRef.current.material.dispose();
        }
      }
      
      // Create bid side terrain
      const bidsGeometries: THREE.BufferGeometry[] = [];
      currentData.bids.forEach((level, i) => {
        let quantity = level.quantity;
        
        // For smooth updates, interpolate between previous and current values
        if (smoothUpdate && previousData && i < previousData.bids.length) {
          const prevLevel = previousData.bids[i];
          quantity = prevLevel.quantity + (level.quantity - prevLevel.quantity) * animationProgress;
        }
        
        const height = (quantity / maxValues.maxQuantity) * 10;
        const width = 1;
        const depth = 1;
        
        const geometry = new THREE.BoxGeometry(width, height, depth);
        
        // Position the box
        geometry.translate(-5, height / 2, -i);
        
        bidsGeometries.push(geometry);
      });
      
      // Create ask side terrain
      const asksGeometries: THREE.BufferGeometry[] = [];
      currentData.asks.forEach((level, i) => {
        let quantity = level.quantity;
        
        // For smooth updates, interpolate between previous and current values
        if (smoothUpdate && previousData && i < previousData.asks.length) {
          const prevLevel = previousData.asks[i];
          quantity = prevLevel.quantity + (level.quantity - prevLevel.quantity) * animationProgress;
        }
        
        const height = (quantity / maxValues.maxQuantity) * 10;
        const width = 1;
        const depth = 1;
        
        const geometry = new THREE.BoxGeometry(width, height, depth);
        
        // Position the box
        geometry.translate(5, height / 2, -i);
        
        asksGeometries.push(geometry);
      });
      
      // Merge geometries for better performance
      if (bidsGeometries.length > 0) {
        const mergedBidsGeometry = mergeBufferGeometries(bidsGeometries);
        const bidsMaterial = new THREE.MeshPhongMaterial({
          color: colors.bidColor,
          wireframe: showWireframe,
          transparent: true,
          opacity: 0.9,
        });
        
        const bidsMesh = new THREE.Mesh(mergedBidsGeometry, bidsMaterial);
        bidsMesh.castShadow = true;
        bidsMesh.receiveShadow = true;
        bidsMesh.userData = { side: 'bids' };
        
        sceneRef.current.add(bidsMesh);
        bidsMeshRef.current = bidsMesh;
      }
      
      if (asksGeometries.length > 0) {
        const mergedAsksGeometry = mergeBufferGeometries(asksGeometries);
        const asksMaterial = new THREE.MeshPhongMaterial({
          color: colors.askColor,
          wireframe: showWireframe,
          transparent: true,
          opacity: 0.9,
        });
        
        const asksMesh = new THREE.Mesh(mergedAsksGeometry, asksMaterial);
        asksMesh.castShadow = true;
        asksMesh.receiveShadow = true;
        asksMesh.userData = { side: 'asks' };
        
        sceneRef.current.add(asksMesh);
        asksMeshRef.current = asksMesh;
      }
      
      // Add spread indicator
      const spreadGeometry = new THREE.BoxGeometry(10, 0.2, currentData.bids.length);
      const spreadMaterial = new THREE.MeshBasicMaterial({
        color: 0xffff00,
        transparent: true,
        opacity: 0.5,
      });
      
      const spreadMesh = new THREE.Mesh(spreadGeometry, spreadMaterial);
      spreadMesh.position.set(0, 0.1, -currentData.bids.length / 2 + 0.5);
      
      sceneRef.current.add(spreadMesh);
      spreadMeshRef.current = spreadMesh;
      
      // Add price labels if enabled
      if (showLabels) {
        const loader = new THREE.TextureLoader();
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        
        if (context) {
          canvas.width = 256;
          canvas.height = 64;
          context.fillStyle = 'rgba(0, 0, 0, 0)';
          context.fillRect(0, 0, canvas.width, canvas.height);
          context.font = '24px Arial';
          context.fillStyle = 'white';
          context.textAlign = 'center';
          context.fillText(formatPrice(currentData.midPrice), 128, 32);
          
          const texture = new THREE.CanvasTexture(canvas);
          const material = new THREE.SpriteMaterial({ map: texture });
          const sprite = new THREE.Sprite(material);
          sprite.position.set(0, 2, 0);
          sprite.scale.set(5, 1.25, 1);
          
          sceneRef.current.add(sprite);
        }
      }
    };
    
    // If animation is enabled, perform smooth update
    if (enableAnimation && smoothUpdate && previousDataRef.current !== data) {
      const animateUpdate = () => {
        if (animationTimeRef.current < 1) {
          animationTimeRef.current += 0.05;
          createTerrain(data, previousDataRef.current, animationTimeRef.current);
          requestAnimationFrame(animateUpdate);
        } else {
          previousDataRef.current = data;
        }
      };
      
      animateUpdate();
    } else {
      // Create terrain immediately
      createTerrain(data, null);
      previousDataRef.current = data;
    }
  }, [data, maxValues, colors, showWireframe, showLabels, enableAnimation, smoothUpdate, isPaused]);
  
  // Update tooltip position
  useEffect(() => {
    if (!tooltipRef.current || !hoveredPoint) return;
    
    const tooltip = tooltipRef.current;
    const mouseX = (mouseRef.current.x + 1) / 2 * width;
    const mouseY = (1 - (mouseRef.current.y + 1) / 2) * height;
    
    tooltip.style.left = `${mouseX + 15}px`;
    tooltip.style.top = `${mouseY}px`;
    tooltip.style.visibility = 'visible';
    
    tooltip.innerHTML = `
      <div class="tooltip-content">
        <div class="tooltip-row">
          <span class="tooltip-label">Price:</span>
          <span class="tooltip-value">${formatPrice(hoveredPoint.price)}</span>
        </div>
        <div class="tooltip-row">
          <span class="tooltip-label">Quantity:</span>
          <span class="tooltip-value">${formatQuantity(hoveredPoint.quantity)}</span>
        </div>
        <div class="tooltip-row">
          <span class="tooltip-label">Side:</span>
          <span class="tooltip-value ${hoveredPoint.side === 'bid' ? 'bid-color' : 'ask-color'}">
            ${hoveredPoint.side === 'bid' ? 'Bid' : 'Ask'}
          </span>
        </div>
        <div class="tooltip-row">
          <span class="tooltip-label">Level:</span>
          <span class="tooltip-value">${hoveredPoint.index + 1}</span>
        </div>
      </div>
    `;
    
    return () => {
      if (tooltipRef.current) {
        tooltipRef.current.style.visibility = 'hidden';
      }
    };
  }, [hoveredPoint, width, height]);
  
  return (
    <div className="order-book-terrain-container">
      <div className="terrain-controls">
        <Button
          onClick={() => setViewMode(viewMode === '3d' ? 'top' : '3d')}
          variant="secondary"
          size="small"
        >
          {viewMode === '3d' ? 'Top View' : '3D View'}
        </Button>
        
        <Button
          onClick={() => setIsPaused(!isPaused)}
          variant="secondary"
          size="small"
        >
          {isPaused ? 'Resume' : 'Pause'}
        </Button>
      </div>
      
      <div
        ref={mountRef}
        className="terrain-canvas"
        style={{ width: `${width}px`, height: `${height}px`, position: 'relative' }}
      >
        {isLoading && (
          <div className="loading-overlay">
            <Spinner size="large" />
            <p>Loading order book data...</p>
          </div>
        )}
        
        {error && (
          <div className="error-overlay">
            <p>Error: {error}</p>
          </div>
        )}
        
        <div
          ref={tooltipRef}
          className="tooltip"
          style={{
            position: 'absolute',
            visibility: 'hidden',
            backgroundColor: colors.tooltipBackground,
            border: `1px solid ${colors.border}`,
            borderRadius: '4px',
            padding: '8px',
            pointerEvents: 'none',
            zIndex: 1000,
            fontSize: '12px',
            color: colors.textPrimary,
            boxShadow: '0 2px 5px rgba(0, 0, 0, 0.2)'
          }}
        />
      </div>
      
      <div className="terrain-info">
        <div className="info-item">
          <span className="info-label">Symbol:</span>
          <span className="info-value">{data.symbol}</span>
        </div>
        <div className="info-item">
          <span className="info-label">Venue:</span>
          <span className="info-value">{data.venue}</span>
        </div>
        <div className="info-item">
          <span className="info-label">Mid Price:</span>
          <span className="info-value">{formatPrice(data.midPrice)}</span>
        </div>
        <div className="info-item">
          <span className="info-label">Spread:</span>
          <span className="info-value">{formatPrice(data.spread)}</span>
        </div>
      </div>
    </div>
  );
};