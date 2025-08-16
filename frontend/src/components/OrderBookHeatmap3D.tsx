import React, { useRef, useEffect } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
import { OrderBookLevel } from '../types/orderBook';

interface OrderBookHeatmap3DProps {
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  maxDepth?: number;
  width: number;
  height: number;
}

export const OrderBookHeatmap3D: React.FC<OrderBookHeatmap3DProps> = ({
  bids,
  asks,
  maxDepth = 50,
  width,
  height
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const frameIdRef = useRef<number | null>(null);
  
  // Find the maximum quantity for scaling
  const maxQuantity = Math.max(
    ...bids.map(level => level.quantity),
    ...asks.map(level => level.quantity)
  );
  
  useEffect(() => {
    if (!containerRef.current) return;
    
    // Initialize Three.js scene
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x111111);
    sceneRef.current = scene;
    
    // Setup camera
    const camera = new THREE.PerspectiveCamera(60, width / height, 0.1, 1000);
    camera.position.set(0, 20, 40);
    cameraRef.current = camera;
    
    // Setup renderer
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(window.devicePixelRatio);
    containerRef.current.appendChild(renderer.domElement);
    rendererRef.current = renderer;
    
    // Add controls
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.25;
    controls.enableZoom = true;
    controlsRef.current = controls;
    
    // Add lights
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
    scene.add(ambientLight);
    
    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight.position.set(0, 50, 50);
    scene.add(directionalLight);
    
    // Add grid helper
    const gridHelper = new THREE.GridHelper(100, 20, 0x555555, 0x333333);
    scene.add(gridHelper);
    
    // Add coordinate axes
    const axesHelper = new THREE.AxesHelper(10);
    scene.add(axesHelper);
    
    // Animation loop
    const animate = () => {
      frameIdRef.current = requestAnimationFrame(animate);
      
      if (controlsRef.current) {
        controlsRef.current.update();
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
      
      if (rendererRef.current && containerRef.current) {
        containerRef.current.removeChild(rendererRef.current.domElement);
      }
      
      // Dispose of Three.js resources
      scene.traverse((object) => {
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
    };
  }, [width, height]);
  
  // Update visualization when order book data changes
  useEffect(() => {
    if (!sceneRef.current) return;
    
    // Clear previous order book visualization
    sceneRef.current.children = sceneRef.current.children.filter(
      child => !(child instanceof THREE.Mesh && child.userData.isOrderBook)
    );
    
    // Create order book terrain
    createOrderBookTerrain();
    
  }, [bids, asks, maxDepth, maxQuantity]);
  
  const createOrderBookTerrain = () => {
    if (!sceneRef.current) return;
    
    // Limit to max depth
    const limitedBids = bids.slice(0, maxDepth);
    const limitedAsks = asks.slice(0, maxDepth);
    
    // Create bid side (green)
    createSideTerrain(limitedBids, -1, new THREE.Color(0x00ff00), new THREE.Color(0x005500));
    
    // Create ask side (red)
    createSideTerrain(limitedAsks, 1, new THREE.Color(0xff0000), new THREE.Color(0x550000));
    
    // Add spread indicator
    if (limitedBids.length > 0 && limitedAsks.length > 0) {
      const spreadSize = Math.abs(limitedAsks[0].price - limitedBids[0].price);
      const spreadMidPrice = (limitedAsks[0].price + limitedBids[0].price) / 2;
      
      const spreadGeometry = new THREE.BoxGeometry(1, 0.1, spreadSize);
      const spreadMaterial = new THREE.MeshBasicMaterial({ color: 0xffff00 });
      const spreadMesh = new THREE.Mesh(spreadGeometry, spreadMaterial);
      
      spreadMesh.position.set(0, 0, 0);
      spreadMesh.userData.isOrderBook = true;
      
      if (sceneRef.current) {
        sceneRef.current.add(spreadMesh);
      }
    }
  };
  
  const createSideTerrain = (
    levels: OrderBookLevel[],
    direction: number,
    startColor: THREE.Color,
    endColor: THREE.Color
  ) => {
    if (!sceneRef.current) return;
    
    const width = 20; // X-axis width of the terrain
    const depth = levels.length; // Z-axis depth (number of price levels)
    
    // Create geometry
    const geometry = new THREE.PlaneGeometry(width, depth, width - 1, depth - 1);
    geometry.rotateX(-Math.PI / 2); // Rotate to be horizontal
    
    // Prepare height map and colors
    const vertices = geometry.attributes.position.array as Float32Array;
    const colors = new Float32Array(vertices.length);
    
    for (let z = 0; z < depth; z++) {
      const level = levels[z] || { price: 0, quantity: 0 };
      const heightScale = level.quantity / maxQuantity * 10; // Scale height by quantity
      
      // Calculate color for this price level (gradient based on height)
      const t = heightScale / 10;
      const color = new THREE.Color().lerpColors(endColor, startColor, t);
      
      for (let x = 0; x < width; x++) {
        const vertexIndex = z * width + x;
        const posIndex = vertexIndex * 3 + 1; // Y component (height)
        
        // Set vertex height
        vertices[posIndex] = heightScale;
        
        // Set vertex color
        const colorIndex = vertexIndex * 3;
        colors[colorIndex] = color.r;
        colors[colorIndex + 1] = color.g;
        colors[colorIndex + 2] = color.b;
      }
    }
    
    // Update geometry
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.attributes.position.needsUpdate = true;
    
    // Create material with vertex colors
    const material = new THREE.MeshPhongMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
      shininess: 30,
      flatShading: true
    });
    
    // Create mesh
    const terrain = new THREE.Mesh(geometry, material);
    terrain.position.set(0, 0, direction * depth / 2);
    terrain.userData.isOrderBook = true;
    
    if (sceneRef.current) {
      sceneRef.current.add(terrain);
    }
  };
  
  return <div ref={containerRef} style={{ width, height }} />;
};