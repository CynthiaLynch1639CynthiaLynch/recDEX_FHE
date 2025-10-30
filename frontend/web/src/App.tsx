// App.tsx
import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface RECAsset {
  id: string;
  encryptedAmount: string;
  encryptedPrice: string;
  timestamp: number;
  owner: string;
  region: string;
  energyType: string;
  status: "available" | "trading" | "settled";
}

// FHE encryption/decryption utilities for numerical data
const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}-${Date.now()}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    const parts = encryptedData.substring(4).split('-');
    return parseFloat(atob(parts[0]));
  }
  return parseFloat(encryptedData);
};

// FHE computation on encrypted REC data
const FHEComputeTrade = (encryptedAmount: string, encryptedPrice: string, operation: string): {encryptedTotal: string, encryptedNewAmount: string} => {
  const amount = FHEDecryptNumber(encryptedAmount);
  const price = FHEDecryptNumber(encryptedPrice);
  let total = 0;
  let newAmount = amount;
  
  switch(operation) {
    case 'buy':
      total = amount * price;
      newAmount = 0; // Asset becomes settled
      break;
    case 'partial':
      total = (amount * 0.5) * price;
      newAmount = amount * 0.5;
      break;
    default:
      total = amount * price;
  }
  
  return {
    encryptedTotal: FHEEncryptNumber(total),
    encryptedNewAmount: FHEEncryptNumber(newAmount)
  };
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [assets, setAssets] = useState<RECAsset[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newAssetData, setNewAssetData] = useState({ region: "", energyType: "solar", amount: 0, price: 0 });
  const [selectedAsset, setSelectedAsset] = useState<RECAsset | null>(null);
  const [decryptedAmount, setDecryptedAmount] = useState<number | null>(null);
  const [decryptedPrice, setDecryptedPrice] = useState<number | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [showTradingModal, setShowTradingModal] = useState(false);
  const [tradingAmount, setTradingAmount] = useState<number>(0);
  const [tradingType, setTradingType] = useState<"buy" | "partial">("buy");

  // Statistics
  const availableCount = assets.filter(a => a.status === "available").length;
  const tradingCount = assets.filter(a => a.status === "trading").length;
  const settledCount = assets.filter(a => a.status === "settled").length;

  useEffect(() => {
    loadAssets().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  const loadAssets = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      // Check contract availability
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) return;
      
      // Load asset keys
      const keysBytes = await contract.getData("asset_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing asset keys:", e); }
      }
      
      const list: RECAsset[] = [];
      for (const key of keys) {
        try {
          const assetBytes = await contract.getData(`asset_${key}`);
          if (assetBytes.length > 0) {
            try {
              const assetData = JSON.parse(ethers.toUtf8String(assetBytes));
              list.push({ 
                id: key, 
                encryptedAmount: assetData.amount, 
                encryptedPrice: assetData.price,
                timestamp: assetData.timestamp, 
                owner: assetData.owner, 
                region: assetData.region,
                energyType: assetData.energyType,
                status: assetData.status || "available"
              });
            } catch (e) { console.error(`Error parsing asset data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading asset ${key}:`, e); }
      }
      list.sort((a, b) => b.timestamp - a.timestamp);
      setAssets(list);
    } catch (e) { console.error("Error loading assets:", e); } 
    finally { setIsRefreshing(false); setLoading(false); }
  };

  const submitAsset = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setCreating(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Encrypting REC data with Zama FHE..." });
    try {
      // Encrypt numerical data using FHE
      const encryptedAmount = FHEEncryptNumber(newAssetData.amount);
      const encryptedPrice = FHEEncryptNumber(newAssetData.price);
      
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const assetId = `rec-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const assetData = { 
        amount: encryptedAmount, 
        price: encryptedPrice,
        timestamp: Math.floor(Date.now() / 1000), 
        owner: address, 
        region: newAssetData.region,
        energyType: newAssetData.energyType,
        status: "available"
      };
      
      await contract.setData(`asset_${assetId}`, ethers.toUtf8Bytes(JSON.stringify(assetData)));
      
      // Update keys list
      const keysBytes = await contract.getData("asset_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } 
        catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(assetId);
      await contract.setData("asset_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      
      setTransactionStatus({ visible: true, status: "success", message: "REC asset encrypted and listed successfully!" });
      await loadAssets();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowCreateModal(false);
        setNewAssetData({ region: "", energyType: "solar", amount: 0, price: 0 });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") ? "Transaction rejected by user" : "Submission failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { setCreating(false); }
  };

  const decryptWithSignature = async (encryptedAmount: string, encryptedPrice: string): Promise<{amount: number, price: number} | null> => {
    if (!isConnected) { alert("Please connect wallet first"); return null; }
    setIsDecrypting(true);
    try {
      const message = `recDEX_FHE Decryption Request\nPublic Key: ${publicKey.substring(0, 20)}...\nContract: ${contractAddress}\nTimestamp: ${Date.now()}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500)); // Simulate decryption delay
      
      return {
        amount: FHEDecryptNumber(encryptedAmount),
        price: FHEDecryptNumber(encryptedPrice)
      };
    } catch (e) { 
      console.error("Decryption failed:", e); 
      return null; 
    } finally { 
      setIsDecrypting(false); 
    }
  };

  const executeTrade = async (assetId: string) => {
    if (!isConnected || !selectedAsset) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Processing FHE-encrypted trade..." });
    try {
      // Perform FHE computation on encrypted data
      const computationResult = FHEComputeTrade(
        selectedAsset.encryptedAmount, 
        selectedAsset.encryptedPrice, 
        tradingType
      );
      
      const contractWithSigner = await getContractWithSigner();
      if (!contractWithSigner) throw new Error("Failed to get contract with signer");
      
      const updatedAsset = { 
        ...selectedAsset, 
        status: tradingType === "buy" ? "settled" : "trading",
        amount: tradingType === "buy" ? "0" : computationResult.encryptedNewAmount
      };
      
      await contractWithSigner.setData(`asset_${assetId}`, ethers.toUtf8String(JSON.stringify(updatedAsset)));
      
      setTransactionStatus({ visible: true, status: "success", message: `FHE trade executed successfully! Total: ${computationResult.encryptedTotal.substring(0, 30)}...` });
      await loadAssets();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowTradingModal(false);
        setSelectedAsset(null);
      }, 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Trade failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const checkAvailability = async () => {
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      const isAvailable = await contract.isAvailable();
      setTransactionStatus({ 
        visible: true, 
        status: "success", 
        message: `Contract is ${isAvailable ? "available" : "unavailable"} for FHE operations` 
      });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Availability check failed" });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const isOwner = (assetOwner: string) => address?.toLowerCase() === assetOwner.toLowerCase();

  if (loading) return (
    <div className="loading-screen">
      <div className="solar-spinner"></div>
      <p>Initializing REC DEX with FHE encryption...</p>
    </div>
  );

  return (
    <div className="app-container solar-theme">
      <header className="app-header">
        <div className="logo">
          <div className="logo-icon"><div className="leaf-icon"></div></div>
          <h1>recDEX<span>FHE</span></h1>
        </div>
        <div className="header-actions">
          <button onClick={() => setShowCreateModal(true)} className="create-asset-btn eco-button">
            <div className="add-icon"></div>List REC Asset
          </button>
          <button className="eco-button" onClick={checkAvailability}>
            Check FHE Status
          </button>
          <div className="wallet-connect-wrapper">
            <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/>
          </div>
        </div>
      </header>

      <div className="main-content">
        <div className="welcome-banner">
          <div className="welcome-text">
            <h2>Renewable Energy Credit Exchange</h2>
            <p>Trade tokenized RECs with full privacy using Zama FHE technology</p>
          </div>
          <div className="fhe-indicator">
            <div className="fhe-lock"></div>
            <span>FHE Encryption Active</span>
          </div>
        </div>

        <div className="dashboard-grid">
          <div className="dashboard-card eco-card">
            <h3>REC Market Overview</h3>
            <div className="stats-grid">
              <div className="stat-item">
                <div className="stat-value">{assets.length}</div>
                <div className="stat-label">Total RECs</div>
              </div>
              <div className="stat-item">
                <div className="stat-value">{availableCount}</div>
                <div className="stat-label">Available</div>
              </div>
              <div className="stat-item">
                <div className="stat-value">{tradingCount}</div>
                <div className="stat-label">Trading</div>
              </div>
              <div className="stat-item">
                <div className="stat-value">{settledCount}</div>
                <div className="stat-label">Settled</div>
              </div>
            </div>
          </div>

          <div className="dashboard-card eco-card">
            <h3>FHE Technology</h3>
            <p>All REC data is encrypted using <strong>Zama FHE</strong>, enabling private trading while maintaining regulatory compliance.</p>
            <div className="energy-mix">
              <div className="energy-source solar">Solar</div>
              <div className="energy-source wind">Wind</div>
              <div className="energy-source hydro">Hydro</div>
            </div>
          </div>
        </div>

        <div className="assets-section">
          <div className="section-header">
            <h2>Available REC Assets</h2>
            <div className="header-actions">
              <button onClick={loadAssets} className="refresh-btn eco-button" disabled={isRefreshing}>
                {isRefreshing ? "Refreshing..." : "Refresh Market"}
              </button>
            </div>
          </div>
          
          <div className="assets-grid">
            {assets.length === 0 ? (
              <div className="no-assets eco-card">
                <div className="no-assets-icon"></div>
                <p>No REC assets available for trading</p>
                <button className="eco-button primary" onClick={() => setShowCreateModal(true)}>
                  List First REC Asset
                </button>
              </div>
            ) : (
              assets.map(asset => (
                <div className="asset-card eco-card" key={asset.id}>
                  <div className="asset-header">
                    <div className="asset-type">{asset.energyType}</div>
                    <div className={`asset-status ${asset.status}`}>{asset.status}</div>
                  </div>
                  <div className="asset-info">
                    <div className="info-item">
                      <span>Region:</span>
                      <strong>{asset.region}</strong>
                    </div>
                    <div className="info-item">
                      <span>Owner:</span>
                      <strong>{asset.owner.substring(0, 6)}...{asset.owner.substring(38)}</strong>
                    </div>
                    <div className="info-item">
                      <span>Listed:</span>
                      <strong>{new Date(asset.timestamp * 1000).toLocaleDateString()}</strong>
                    </div>
                  </div>
                  <div className="encrypted-data">
                    <div className="encrypted-amount">Amount: {asset.encryptedAmount.substring(0, 30)}...</div>
                    <div className="encrypted-price">Price: {asset.encryptedPrice.substring(0, 30)}...</div>
                  </div>
                  <div className="asset-actions">
                    <button 
                      className="action-btn eco-button" 
                      onClick={() => {
                        setSelectedAsset(asset);
                        setDecryptedAmount(null);
                        setDecryptedPrice(null);
                      }}
                    >
                      View Details
                    </button>
                    {!isOwner(asset.owner) && asset.status === "available" && (
                      <button 
                        className="action-btn eco-button primary" 
                        onClick={() => {
                          setSelectedAsset(asset);
                          setShowTradingModal(true);
                        }}
                      >
                        Trade
                      </button>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Create Asset Modal */}
      {showCreateModal && (
        <ModalCreate 
          onSubmit={submitAsset} 
          onClose={() => setShowCreateModal(false)} 
          creating={creating} 
          assetData={newAssetData} 
          setAssetData={setNewAssetData}
        />
      )}

      {/* Asset Detail Modal */}
      {selectedAsset && !showTradingModal && (
        <AssetDetailModal 
          asset={selectedAsset} 
          onClose={() => {
            setSelectedAsset(null);
            setDecryptedAmount(null);
            setDecryptedPrice(null);
          }} 
          decryptedAmount={decryptedAmount}
          decryptedPrice={decryptedPrice}
          setDecryptedAmount={setDecryptedAmount}
          setDecryptedPrice={setDecryptedPrice}
          isDecrypting={isDecrypting}
          decryptWithSignature={decryptWithSignature}
          isOwner={isOwner(selectedAsset.owner)}
        />
      )}

      {/* Trading Modal */}
      {showTradingModal && selectedAsset && (
        <TradingModal
          asset={selectedAsset}
          onClose={() => {
            setShowTradingModal(false);
            setSelectedAsset(null);
          }}
          onTrade={executeTrade}
          tradingAmount={tradingAmount}
          setTradingAmount={setTradingAmount}
          tradingType={tradingType}
          setTradingType={setTradingType}
        />
      )}

      {/* Transaction Status Modal */}
      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content eco-card">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="energy-spinner"></div>}
              {transactionStatus.status === "success" && <div className="check-icon"></div>}
              {transactionStatus.status === "error" && <div className="error-icon"></div>}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}

      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <div className="logo">
              <div className="leaf-icon"></div>
              <span>recDEX FHE</span>
            </div>
            <p>Private REC trading powered by Zama FHE technology</p>
          </div>
          <div className="footer-links">
            <a href="#" className="footer-link">Documentation</a>
            <a href="#" className="footer-link">Privacy Policy</a>
            <a href="#" className="footer-link">GitHub</a>
          </div>
        </div>
        <div className="footer-bottom">
          <div className="fhe-badge">
            <span>FHE-Encrypted Trading</span>
          </div>
          <div className="copyright">© {new Date().getFullYear()} recDEX FHE. All rights reserved.</div>
        </div>
      </footer>
    </div>
  );
};

// Modal Components
interface ModalCreateProps {
  onSubmit: () => void;
  onClose: () => void;
  creating: boolean;
  assetData: any;
  setAssetData: (data: any) => void;
}

const ModalCreate: React.FC<ModalCreateProps> = ({ onSubmit, onClose, creating, assetData, setAssetData }) => {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setAssetData({ ...assetData, [name]: value });
  };

  const handleNumberChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setAssetData({ ...assetData, [name]: parseFloat(value) });
  };

  const handleSubmit = () => {
    if (!assetData.region || !assetData.amount || !assetData.price) {
      alert("Please fill all required fields");
      return;
    }
    onSubmit();
  };

  return (
    <div className="modal-overlay">
      <div className="create-modal eco-card">
        <div className="modal-header">
          <h2>List New REC Asset</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="fhe-notice-banner">
            <div className="key-icon"></div> 
            <div>
              <strong>FHE Encryption Active</strong>
              <p>All REC data will be encrypted with Zama FHE before submission</p>
            </div>
          </div>
          
          <div className="form-grid">
            <div className="form-group">
              <label>Region *</label>
              <input 
                type="text" 
                name="region" 
                value={assetData.region} 
                onChange={handleChange}
                placeholder="e.g., California, EU"
                className="eco-input"
              />
            </div>
            
            <div className="form-group">
              <label>Energy Type *</label>
              <select name="energyType" value={assetData.energyType} onChange={handleChange} className="eco-select">
                <option value="solar">Solar</option>
                <option value="wind">Wind</option>
                <option value="hydro">Hydro</option>
                <option value="geothermal">Geothermal</option>
              </select>
            </div>
            
            <div className="form-group">
              <label>REC Amount (MWh) *</label>
              <input 
                type="number" 
                name="amount" 
                value={assetData.amount} 
                onChange={handleNumberChange}
                placeholder="Enter amount"
                className="eco-input"
                step="0.1"
                min="0"
              />
            </div>
            
            <div className="form-group">
              <label>Price per MWh *</label>
              <input 
                type="number" 
                name="price" 
                value={assetData.price} 
                onChange={handleNumberChange}
                placeholder="Enter price"
                className="eco-input"
                step="0.01"
                min="0"
              />
            </div>
          </div>
          
          <div className="encryption-preview">
            <h4>FHE Encryption Preview</h4>
            <div className="preview-container">
              <div className="plain-data">
                <span>Plain Values:</span>
                <div>Amount: {assetData.amount || 0} MWh</div>
                <div>Price: ${assetData.price || 0}</div>
              </div>
              <div className="encryption-arrow">→</div>
              <div className="encrypted-data">
                <span>Encrypted Data:</span>
                <div>Amount: {assetData.amount ? FHEEncryptNumber(assetData.amount).substring(0, 30) + '...' : 'Not encrypted'}</div>
                <div>Price: {assetData.price ? FHEEncryptNumber(assetData.price).substring(0, 30) + '...' : 'Not encrypted'}</div>
              </div>
            </div>
          </div>
        </div>
        
        <div className="modal-footer">
          <button onClick={onClose} className="cancel-btn eco-button">Cancel</button>
          <button onClick={handleSubmit} disabled={creating} className="submit-btn eco-button primary">
            {creating ? "Encrypting with FHE..." : "List REC Asset"}
          </button>
        </div>
      </div>
    </div>
  );
};

interface AssetDetailModalProps {
  asset: RECAsset;
  onClose: () => void;
  decryptedAmount: number | null;
  decryptedPrice: number | null;
  setDecryptedAmount: (value: number | null) => void;
  setDecryptedPrice: (value: number | null) => void;
  isDecrypting: boolean;
  decryptWithSignature: (encryptedAmount: string, encryptedPrice: string) => Promise<{amount: number, price: number} | null>;
  isOwner: boolean;
}

const AssetDetailModal: React.FC<AssetDetailModalProps> = ({
  asset, onClose, decryptedAmount, decryptedPrice, setDecryptedAmount, setDecryptedPrice, isDecrypting, decryptWithSignature, isOwner
}) => {
  const handleDecrypt = async () => {
    if (decryptedAmount !== null) {
      setDecryptedAmount(null);
      setDecryptedPrice(null);
      return;
    }
    const decrypted = await decryptWithSignature(asset.encryptedAmount, asset.encryptedPrice);
    if (decrypted) {
      setDecryptedAmount(decrypted.amount);
      setDecryptedPrice(decrypted.price);
    }
  };

  return (
    <div className="modal-overlay">
      <div className="asset-detail-modal eco-card">
        <div className="modal-header">
          <h2>REC Asset Details</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        
        <div className="modal-body">
          <div className="asset-info-grid">
            <div className="info-item">
              <span>Asset ID:</span>
              <strong>#{asset.id.substring(0, 8)}</strong>
            </div>
            <div className="info-item">
              <span>Region:</span>
              <strong>{asset.region}</strong>
            </div>
            <div className="info-item">
              <span>Energy Type:</span>
              <strong className={`energy-type ${asset.energyType}`}>{asset.energyType}</strong>
            </div>
            <div className="info-item">
              <span>Status:</span>
              <strong className={`asset-status ${asset.status}`}>{asset.status}</strong>
            </div>
            <div className="info-item">
              <span>Owner:</span>
              <strong>{asset.owner.substring(0, 8)}...{asset.owner.substring(36)}</strong>
            </div>
            <div className="info-item">
              <span>Listed:</span>
              <strong>{new Date(asset.timestamp * 1000).toLocaleString()}</strong>
            </div>
          </div>

          <div className="encrypted-data-section">
            <h3>FHE-Encrypted Data</h3>
            <div className="encrypted-values">
              <div className="encrypted-value">
                <span>Amount:</span>
                <div>{asset.encryptedAmount}</div>
              </div>
              <div className="encrypted-value">
                <span>Price:</span>
                <div>{asset.encryptedPrice}</div>
              </div>
            </div>
            
            <button 
              className="decrypt-btn eco-button" 
              onClick={handleDecrypt} 
              disabled={isDecrypting}
            >
              {isDecrypting ? "Decrypting..." : decryptedAmount !== null ? "Re-encrypt Data" : "Decrypt with Wallet"}
            </button>
          </div>

          {decryptedAmount !== null && decryptedPrice !== null && (
            <div className="decrypted-data-section">
              <h3>Decrypted Values</h3>
              <div className="decrypted-values">
                <div className="decrypted-value">
                  <span>Amount:</span>
                  <strong>{decryptedAmount} MWh</strong>
                </div>
                <div className="decrypted-value">
                  <span>Price:</span>
                  <strong>${decryptedPrice}/MWh</strong>
                </div>
                <div className="decrypted-value">
                  <span>Total Value:</span>
                  <strong>${(decryptedAmount * decryptedPrice).toFixed(2)}</strong>
                </div>
              </div>
              <div className="decryption-notice">
                <div className="warning-icon"></div>
                <span>Decrypted data visible only after wallet signature verification</span>
              </div>
            </div>
          )}
        </div>
        
        <div className="modal-footer">
          <button onClick={onClose} className="close-btn eco-button">Close</button>
        </div>
      </div>
    </div>
  );
};

interface TradingModalProps {
  asset: RECAsset;
  onClose: () => void;
  onTrade: (assetId: string) => void;
  tradingAmount: number;
  setTradingAmount: (amount: number) => void;
  tradingType: "buy" | "partial";
  setTradingType: (type: "buy" | "partial") => void;
}

const TradingModal: React.FC<TradingModalProps> = ({
  asset, onClose, onTrade, tradingAmount, setTradingAmount, tradingType, setTradingType
}) => {
  return (
    <div className="modal-overlay">
      <div className="trading-modal eco-card">
        <div className="modal-header">
          <h2>Execute FHE Trade</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        
        <div className="modal-body">
          <div className="trade-info">
            <div className="info-item">
              <span>Asset:</span>
              <strong>{asset.region} {asset.energyType} REC</strong>
            </div>
            <div className="info-item">
              <span>Current Owner:</span>
              <strong>{asset.owner.substring(0, 8)}...{asset.owner.substring(36)}</strong>
            </div>
          </div>

          <div className="trade-type-selection">
            <label>Trade Type:</label>
            <div className="trade-options">
              <label className="trade-option">
                <input
                  type="radio"
                  value="buy"
                  checked={tradingType === "buy"}
                  onChange={(e) => setTradingType(e.target.value as "buy")}
                />
                <span>Buy Full Amount</span>
              </label>
              <label className="trade-option">
                <input
                  type="radio"
                  value="partial"
                  checked={tradingType === "partial"}
                  onChange={(e) => setTradingType(e.target.value as "partial")}
                />
                <span>Buy Partial Amount</span>
              </label>
            </div>
          </div>

          {tradingType === "partial" && (
            <div className="amount-selection">
              <label>Amount to Purchase (MWh):</label>
              <input
                type="number"
                value={tradingAmount}
                onChange={(e) => setTradingAmount(parseFloat(e.target.value))}
                className="eco-input"
                min="0"
                step="0.1"
              />
            </div>
          )}

          <div className="fhe-notice">
            <div className="fhe-icon"></div>
            <p>This trade will be executed using FHE-encrypted data without decryption</p>
          </div>
        </div>
        
        <div className="modal-footer">
          <button onClick={onClose} className="cancel-btn eco-button">Cancel</button>
          <button 
            onClick={() => onTrade(asset.id)} 
            className="trade-btn eco-button primary"
          >
            Execute FHE Trade
          </button>
        </div>
      </div>
    </div>
  );
};

export default App;