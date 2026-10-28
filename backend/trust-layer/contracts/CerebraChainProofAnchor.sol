// SPDX-License-Identifier: MIT
pragma solidity >=0.8.17 <0.9.0;

/// @title CerebraChainProofAnchor
/// @notice Stores integrity commitments for externally verified
///         Groth16 proof sets.
/// @dev This contract does NOT verify the individual Groth16 proofs.
///      Recording a root is not proof of clinical or training validity.
contract CerebraChainProofAnchor {

    error Unauthorized();
    error InvalidAnchorData();
    error AnchorIdMismatch();
    error AlreadyAnchored();

    address public immutable owner;

    struct AnchorRecord {
        bytes32 proofMerkleRoot;
        bytes32 transcriptHash;
        bytes32 manifestSha256;
        uint256 proofCount;
        uint256 offlineRoundId;
        uint256 timestamp;
        address submitter;
    }

    mapping(bytes32 => AnchorRecord) private records;

    event ProofSetAnchored(
        bytes32 indexed anchorId,
        bytes32 indexed proofMerkleRoot,
        bytes32 indexed transcriptHash,
        bytes32 manifestSha256,
        uint256 proofCount,
        uint256 offlineRoundId,
        address submitter
    );

    constructor() {
        owner = msg.sender;
    }

    /// @notice Matches the Python proof-set anchor formula.
    /// SHA256(0x02 || proofMerkleRoot || transcriptHash)
    function computeAnchorId(
        bytes32 proofMerkleRoot,
        bytes32 transcriptHash
    ) public pure returns (bytes32) {
        return sha256(
            abi.encodePacked(
                bytes1(0x02),
                proofMerkleRoot,
                transcriptHash
            )
        );
    }

    /// @notice Record an independently audited proof set.
    /// @dev Owner attestation only; proofs are not verified here.
    function anchorProofSet(
        bytes32 expectedAnchorId,
        bytes32 proofMerkleRoot,
        bytes32 transcriptHash,
        bytes32 manifestSha256,
        uint256 proofCount,
        uint256 offlineRoundId
    ) external returns (bytes32) {

        if (msg.sender != owner) {
            revert Unauthorized();
        }

        if (
            proofMerkleRoot == bytes32(0) ||
            transcriptHash == bytes32(0) ||
            manifestSha256 == bytes32(0) ||
            proofCount == 0
        ) {
            revert InvalidAnchorData();
        }

        bytes32 anchorId = computeAnchorId(
            proofMerkleRoot,
            transcriptHash
        );

        if (anchorId != expectedAnchorId) {
            revert AnchorIdMismatch();
        }

        if (records[anchorId].submitter != address(0)) {
            revert AlreadyAnchored();
        }

        records[anchorId] = AnchorRecord({
            proofMerkleRoot: proofMerkleRoot,
            transcriptHash: transcriptHash,
            manifestSha256: manifestSha256,
            proofCount: proofCount,
            offlineRoundId: offlineRoundId,
            timestamp: block.timestamp,
            submitter: msg.sender
        });

        emit ProofSetAnchored(
            anchorId,
            proofMerkleRoot,
            transcriptHash,
            manifestSha256,
            proofCount,
            offlineRoundId,
            msg.sender
        );

        return anchorId;
    }

    function isAnchored(
        bytes32 anchorId
    ) external view returns (bool) {
        return records[anchorId].submitter != address(0);
    }

    function getAnchor(
        bytes32 anchorId
    ) external view returns (AnchorRecord memory) {
        return records[anchorId];
    }
}
