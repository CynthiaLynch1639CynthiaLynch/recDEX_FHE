pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract RecDexFHE is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    address public owner;
    mapping(address => bool) public isProvider;
    bool public paused;
    uint256 public cooldownSeconds;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;

    uint256 public currentBatchId;
    mapping(uint256 => bool) public isBatchClosed;

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    // Errors
    error NotOwner();
    error NotProvider();
    error Paused();
    error CooldownActive();
    error InvalidBatch();
    error ReplayAttempt();
    error StateMismatch();
    error DecryptionFailed();

    // Events
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event PauseToggled(bool indexed paused);
    event CooldownSet(uint256 indexed cooldownSeconds);
    event BatchOpened(uint256 indexed batchId);
    event BatchClosed(uint256 indexed batchId);
    event EncryptedDataSubmitted(address indexed provider, uint256 indexed batchId, bytes32 encryptedData);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId);
    event DecryptionCompleted(uint256 indexed requestId, uint256 indexed batchId, uint256[] cleartextValues);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    constructor() {
        owner = msg.sender;
        isProvider[owner] = true;
        emit ProviderAdded(owner);
        cooldownSeconds = 60; // Default cooldown
    }

    function transferOwnership(address newOwner) external onlyOwner {
        address previousOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(previousOwner, newOwner);
    }

    function addProvider(address provider) external onlyOwner {
        if (!isProvider[provider]) {
            isProvider[provider] = true;
            emit ProviderAdded(provider);
        }
    }

    function removeProvider(address provider) external onlyOwner {
        if (isProvider[provider]) {
            isProvider[provider] = false;
            emit ProviderRemoved(provider);
        }
    }

    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
        emit PauseToggled(_paused);
    }

    function setCooldown(uint256 _cooldownSeconds) external onlyOwner {
        cooldownSeconds = _cooldownSeconds;
        emit CooldownSet(_cooldownSeconds);
    }

    function openBatch() external onlyOwner whenNotPaused {
        currentBatchId++;
        isBatchClosed[currentBatchId] = false;
        emit BatchOpened(currentBatchId);
    }

    function closeBatch(uint256 batchId) external onlyOwner whenNotPaused {
        if (batchId != currentBatchId) revert InvalidBatch();
        isBatchClosed[batchId] = true;
        emit BatchClosed(batchId);
    }

    function submitEncryptedData(uint256 batchId, bytes32 encryptedData) external onlyProvider whenNotPaused {
        if (block.timestamp < lastSubmissionTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        if (isBatchClosed[batchId]) revert InvalidBatch();

        lastSubmissionTime[msg.sender] = block.timestamp;

        // In a real DEX, this would involve more complex FHE operations
        // and storage of the encryptedData. For this example, we'll just emit.
        // Assume encryptedData is an euint32 representing some REC attribute.
        emit EncryptedDataSubmitted(msg.sender, batchId, encryptedData);
    }

    function requestBatchSummaryDecryption(uint256 batchId) external onlyProvider whenNotPaused {
        if (block.timestamp < lastDecryptionRequestTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        if (!isBatchClosed[batchId]) revert InvalidBatch(); // Batch must be closed for summary

        lastDecryptionRequestTime[msg.sender] = block.timestamp;

        // 1. Prepare Ciphertexts
        // For this example, we'll create a dummy euint32 representing a summary.
        // In a real DEX, this would be an aggregation of multiple encrypted trades.
        euint32 memory dummySummary = FHE.asEuint32(0); // Placeholder for actual FHE computation

        bytes32[] memory cts = new bytes32[](1);
        cts[0] = FHE.toBytes32(dummySummary);

        // 2. Compute State Hash
        bytes32 stateHash = keccak256(abi.encode(cts, address(this)));

        // 3. Request Decryption
        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);

        // 4. Store Context
        decryptionContexts[requestId] = DecryptionContext({ batchId: batchId, stateHash: stateHash, processed: false });
        emit DecryptionRequested(requestId, batchId);
    }

    function myCallback(uint256 requestId, bytes memory cleartexts, bytes memory proof) public {
        // a. Replay Guard
        if (decryptionContexts[requestId].processed) {
            revert ReplayAttempt();
        }

        // b. State Verification
        // Rebuild cts array in the exact same order as in requestBatchSummaryDecryption
        // This requires re-computing the dummySummary or fetching it from storage if it was stored.
        // For this example, we'll re-create the dummySummary.
        euint32 memory dummySummary = FHE.asEuint32(0); // Must match the one used in requestBatchSummaryDecryption
        bytes32[] memory cts = new bytes32[](1);
        cts[0] = FHE.toBytes32(dummySummary);

        bytes32 currentHash = keccak256(abi.encode(cts, address(this)));
        if (currentHash != decryptionContexts[requestId].stateHash) {
            revert StateMismatch();
        }

        // c. Proof Verification
        if (!FHE.checkSignatures(requestId, cleartexts, proof)) {
            revert DecryptionFailed();
        }

        // d. Decode & Finalize
        // Decode cleartexts in the same order as cts
        uint256 summaryValue = abi.decode(cleartexts, (uint256));
        decryptionContexts[requestId].processed = true;
        emit DecryptionCompleted(requestId, decryptionContexts[requestId].batchId, [summaryValue]);
    }

    // Internal Helper Functions
    function _hashCiphertexts(bytes32[] memory cts) internal view returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function _initIfNeeded(euint32 s) internal view {
        s.isInitialized();
    }

    function _requireInitialized(euint32 s) internal view {
        if (!s.isInitialized()) {
            revert("FHE: euint32 not initialized");
        }
    }
}