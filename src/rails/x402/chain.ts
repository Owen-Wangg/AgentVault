import { type Hex, decodeEventLog, decodeFunctionResult, encodeEventTopics, encodeFunctionData, parseAbi } from "viem";
import { z } from "zod";
import { BASE_SEPOLIA_CHAIN_ID, BASE_SEPOLIA_RPC_URL, USDC_BASE_SEPOLIA } from "./constants";

/**
 * Read-only Base Sepolia access over JSON-RPC (rail-adapters design,
 * "lookup() per rail"). It has no method that sends a transaction, so
 * nothing built on it can pay (RAIL-22). Every response is checked with
 * Zod (RAIL-5) and the chain ID is confirmed before the first read, so a
 * misconfigured endpoint can't answer for another network (RAIL-8).
 * `fetch` is injected: tests replay recorded responses.
 */

export const USDC_ABI = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
  "event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

export class ChainReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChainReadError";
  }
}

const HexString = z.string().regex(/^0x[0-9a-fA-F]*$/);
const Quantity = z
  .string()
  .regex(/^0x[0-9a-fA-F]{1,64}$/)
  .transform((v) => BigInt(v));
const Hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const Address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

const RpcEnvelope = z.union([
  z.object({ jsonrpc: z.literal("2.0"), id: z.number(), result: z.unknown() }),
  z.object({ jsonrpc: z.literal("2.0"), id: z.number().nullable(), error: z.object({ code: z.number(), message: z.string() }) }),
]);

const Block = z.object({ number: Quantity, timestamp: Quantity, hash: Hash });
const Log = z.object({
  address: Address,
  topics: z.array(Hash),
  data: HexString,
  blockNumber: Quantity,
  transactionHash: Hash,
  removed: z.boolean().optional(),
});
const Receipt = z.object({ status: z.enum(["0x0", "0x1"]), transactionHash: Hash, blockNumber: Quantity, logs: z.array(Log) });

export type ChainBlock = z.infer<typeof Block>;
export type ChainLog = z.infer<typeof Log>;
export type ChainReceipt = z.infer<typeof Receipt>;
export type BlockTag = "latest" | "finalized" | bigint;

const tag = (b: BlockTag): string => (typeof b === "bigint" ? `0x${b.toString(16)}` : b);

export interface ChainReaderOptions {
  fetch?: typeof fetch;
  rpcUrl?: string;
}

export class BaseSepoliaReader {
  private readonly fetchFn: typeof fetch;
  private readonly rpcUrl: string;
  private chainChecked = false;
  private nextId = 1;

  constructor(options: ChainReaderOptions = {}) {
    this.fetchFn = options.fetch ?? globalThis.fetch;
    this.rpcUrl = options.rpcUrl ?? BASE_SEPOLIA_RPC_URL;
  }

  private async call(method: string, params: unknown[], signal?: AbortSignal): Promise<unknown> {
    const id = this.nextId++;
    const response = await this.fetchFn(this.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) throw new ChainReadError(`${method}: RPC answered HTTP ${response.status}`);
    const parsed = RpcEnvelope.safeParse(await response.json());
    if (!parsed.success) throw new ChainReadError(`${method}: malformed JSON-RPC response`);
    if ("error" in parsed.data) throw new ChainReadError(`${method}: RPC error ${parsed.data.error.code}`);
    return parsed.data.result;
  }

  private async read<T>(schema: z.ZodType<T>, method: string, params: unknown[], signal?: AbortSignal): Promise<T> {
    if (!this.chainChecked) {
      const chainId = Quantity.safeParse(await this.call("eth_chainId", [], signal));
      if (!chainId.success || chainId.data !== BigInt(BASE_SEPOLIA_CHAIN_ID)) throw new ChainReadError("the RPC endpoint is not Base Sepolia");
      this.chainChecked = true;
    }
    const parsed = schema.safeParse(await this.call(method, params, signal));
    if (!parsed.success) throw new ChainReadError(`${method}: unexpected result`);
    return parsed.data;
  }

  async block(at: BlockTag, signal?: AbortSignal): Promise<ChainBlock> {
    return this.read(Block, "eth_getBlockByNumber", [tag(at), false], signal);
  }

  async ethBalance(address: Hex, signal?: AbortSignal): Promise<bigint> {
    return this.read(Quantity, "eth_getBalance", [address, "latest"], signal);
  }

  private async usdcCall(data: Hex, at: BlockTag, signal?: AbortSignal): Promise<Hex> {
    return (await this.read(HexString, "eth_call", [{ to: USDC_BASE_SEPOLIA, data }, tag(at)], signal)) as Hex;
  }

  async usdcBalance(address: Hex, signal?: AbortSignal): Promise<bigint> {
    const data = encodeFunctionData({ abi: USDC_ABI, functionName: "balanceOf", args: [address] });
    return decodeFunctionResult({ abi: USDC_ABI, functionName: "balanceOf", data: await this.usdcCall(data, "latest", signal) });
  }

  /** EIP-3009: true once an authorization with this nonce has been used (or canceled). */
  async authorizationUsed(authorizer: Hex, nonce: Hex, at: BlockTag, signal?: AbortSignal): Promise<boolean> {
    const data = encodeFunctionData({ abi: USDC_ABI, functionName: "authorizationState", args: [authorizer, nonce] });
    return decodeFunctionResult({ abi: USDC_ABI, functionName: "authorizationState", data: await this.usdcCall(data, at, signal) });
  }

  /** `AuthorizationUsed(authorizer, nonce)` logs from the USDC contract in a block range. */
  async authorizationUsedLogs(authorizer: Hex, nonce: Hex, fromBlock: bigint, toBlock: bigint, signal?: AbortSignal): Promise<ChainLog[]> {
    const topics = encodeEventTopics({ abi: USDC_ABI, eventName: "AuthorizationUsed", args: { authorizer, nonce } });
    const logs = await this.read(z.array(Log), "eth_getLogs", [{ address: USDC_BASE_SEPOLIA, topics, fromBlock: tag(fromBlock), toBlock: tag(toBlock) }], signal);
    return logs.filter((l) => !l.removed && l.address.toLowerCase() === USDC_BASE_SEPOLIA.toLowerCase());
  }

  async receipt(hash: Hex, signal?: AbortSignal): Promise<ChainReceipt | null> {
    return this.read(Receipt.nullable(), "eth_getTransactionReceipt", [hash], signal);
  }
}

/** USDC moved from `from` in a receipt's Transfer logs, in atomic units. */
export function usdcTransferredFrom(receipt: ChainReceipt, from: Hex): { to: Hex; value: bigint }[] {
  const out: { to: Hex; value: bigint }[] = [];
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== USDC_BASE_SEPOLIA.toLowerCase()) continue;
    try {
      const event = decodeEventLog({ abi: USDC_ABI, data: log.data as Hex, topics: log.topics as [Hex, ...Hex[]] });
      if (event.eventName === "Transfer" && event.args.from.toLowerCase() === from.toLowerCase()) out.push({ to: event.args.to, value: event.args.value });
    } catch {
      // Not one of the events above.
    }
  }
  return out;
}
