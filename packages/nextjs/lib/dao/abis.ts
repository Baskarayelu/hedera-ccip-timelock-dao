import { parseAbi } from "viem";

export {
  crossChainExecutorAbi,
  daoAccountAbi,
  daoGovernorAbi,
  daoTimelockAbi,
  govTokenFaucetAbi,
  remoteParametersAbi,
  voteTokenAbi,
} from "~~/contracts/abis";

/** An HTS fungible token through its EVM facade: ERC-20 plus HIP-719 association. */
export const htsTokenAbi = parseAbi([
  "function associate() returns (uint256 responseCode)",
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
]);

const evm2AnyMessage = {
  name: "message",
  type: "tuple",
  components: [
    { name: "receiver", type: "bytes" },
    { name: "data", type: "bytes" },
    {
      name: "tokenAmounts",
      type: "tuple[]",
      components: [
        { name: "token", type: "address" },
        { name: "amount", type: "uint256" },
      ],
    },
    { name: "feeToken", type: "address" },
    { name: "extraArgs", type: "bytes" },
  ],
} as const;

/** The one Chainlink CCIP Router call the frontend makes: a fee quote. */
export const ccipRouterAbi = [
  {
    type: "function",
    name: "getFee",
    stateMutability: "view",
    inputs: [{ name: "destChainSelector", type: "uint64" }, evm2AnyMessage],
    outputs: [{ name: "fee", type: "uint256" }],
  },
] as const;

/** `CrossChainMessages.Request`, as `abi.encode(request)` lays it out. */
export const requestParameters = [
  {
    type: "tuple",
    components: [
      { name: "version", type: "uint8" },
      { name: "validUntil", type: "uint64" },
      {
        name: "calls",
        type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "value", type: "uint256" },
          { name: "data", type: "bytes" },
        ],
      },
    ],
  },
] as const;
