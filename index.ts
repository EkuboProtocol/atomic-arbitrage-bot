import "dotenv/config";

import { Account, Call, Contract, num, RpcProvider } from "starknet";
import ROUTER_ABI from "./router-abi.json";

const EKUBO_API_QUOTE_URL = process.env.EKUBO_API_QUOTE_URL;
const TOKEN_TO_ARBITRAGE = process.env.TOKEN_TO_ARBITRAGE!;
const MAX_HOPS = Math.max(2, Number(process.env.MAX_HOPS));
const MAX_SPLITS = Math.max(0, Number(process.env.MAX_SPLITS));
const CHECK_INTERVAL_MS = Math.max(3000, Number(process.env.CHECK_INTERVAL_MS));
const MIN_POWER_OF_2 = Math.max(32, Number(process.env.MIN_POWER_OF_2));
const MAX_POWER_OF_2 = Math.max(
  MIN_POWER_OF_2 + 1,
  Math.min(65, Number(process.env.MAX_POWER_OF_2))
);
const MIN_PROFIT = BigInt(Math.max(0, Number(process.env.MIN_PROFIT)));
const NUM_TOP_QUOTES_TO_ESTIMATE = Math.max(
  1,
  Number(process.env.NUM_TOP_QUOTES_TO_ESTIMATE)
);

const JSON_RPC_URL = process.env.JSON_RPC_URL;

const RPC_PROVIDER = new RpcProvider({
  nodeUrl: JSON_RPC_URL,
});

const ACCOUNT = new Account(
  RPC_PROVIDER,
  process.env.ACCOUNT_ADDRESS!,
  process.env.ACCOUNT_PRIVATE_KEY!
);

const ROUTER_CONTRACT = new Contract(
  ROUTER_ABI,
  process.env.ROUTER_ADDRESS!,
  RPC_PROVIDER
);

export interface ApiQuoteSwap {
  specifiedAmount: string;
  amount: string;
  route: {
    pool_key: {
      token0: string;
      token1: string;
      fee: string;
      tick_spacing: number;
      extension: string;
    };
    sqrt_ratio_limit: string;
    skip_ahead: string;
  }[];
}

export interface QuoteApiResponse {
  total: string;
  splits: ApiQuoteSwap[];
}

async function fetchQuote(amount: bigint): Promise<QuoteApiResponse | null> {
  const quote = await fetch(
    `${EKUBO_API_QUOTE_URL}/${amount}/${TOKEN_TO_ARBITRAGE}/${TOKEN_TO_ARBITRAGE}?maxHops=${MAX_HOPS}&maxSplits=${MAX_SPLITS}`
  );
  if (!quote.ok) {
    return null;
  }
  return (await quote.json()) as QuoteApiResponse;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const AMOUNTS_TO_QUOTE = Array(MAX_POWER_OF_2 - MIN_POWER_OF_2)
  .fill(null)
  .map((_, ix) => 2n ** BigInt(ix + MIN_POWER_OF_2));

console.log("Starting with config", {
  EKUBO_API_QUOTE_URL,
  JSON_RPC_URL,
  TOKEN_TO_ARBITRAGE,
  MAX_HOPS,
  MAX_SPLITS,
  CHECK_INTERVAL_MS,
  AMOUNTS_TO_QUOTE,
});

(async function () {
  while (true) {
    const topArbitrageResults = (
      await Promise.all(
        AMOUNTS_TO_QUOTE.map(async (amount) => {
          const quote = await fetchQuote(amount);

          if (!quote) {
            return null;
          }

          return {
            amount,
            quote,
            profit: BigInt(quote.total) - amount,
          };
        })
      )
    )
      // filters to the on-paper profitable quotes (not accounting for gas)
      .filter((quote): quote is Exclude<typeof quote, null> =>
        Boolean(quote && quote.profit > MIN_PROFIT)
      )
      .sort(({ profit: profitA }, { profit: profitB }) =>
        Number(profitB - profitA)
      )
      .slice(0, NUM_TOP_QUOTES_TO_ESTIMATE)
      .map((result): typeof result & { calls: Call[] } => {
        const {
          amount,
          quote: { total, splits },
        } = result;

        if (splits.length === 0) {
          throw new Error("unexpected number of splits");
        }

        const transferCall = {
          contractAddress: TOKEN_TO_ARBITRAGE,
          entrypoint: "transfer",
          calldata: [ROUTER_CONTRACT.address, num.toHex(amount), "0x0"],
        };

        const clearProfitsCall = ROUTER_CONTRACT.populate("clear_minimum", [
          { contract_address: TOKEN_TO_ARBITRAGE },
          amount,
        ]);

        if (splits.length === 1) {
          const split = splits[0];
          if (split.route.length === 1) {
            throw new Error("unexpected single hop route");
          } else {
            return {
              ...result,
              calls: [
                transferCall,
                {
                  contractAddress: ROUTER_CONTRACT.address,
                  entrypoint: "multihop_swap",

                  calldata: [
                    num.toHex(split.route.length),
                    ...split.route.reduce<{
                      token: string;
                      encoded: string[];
                    }>(
                      (memo, routeNode) => {
                        const isToken1 =
                          BigInt(memo.token) ===
                          BigInt(routeNode.pool_key.token1);

                        return {
                          token: isToken1
                            ? routeNode.pool_key.token0
                            : routeNode.pool_key.token1,
                          encoded: memo.encoded.concat([
                            routeNode.pool_key.token0,
                            routeNode.pool_key.token1,
                            routeNode.pool_key.fee,
                            num.toHex(routeNode.pool_key.tick_spacing),
                            routeNode.pool_key.extension,
                            num.toHex(
                              BigInt(routeNode.sqrt_ratio_limit) % 2n ** 128n
                            ),
                            num.toHex(
                              BigInt(routeNode.sqrt_ratio_limit) >> 128n
                            ),
                            routeNode.skip_ahead,
                          ]),
                        };
                      },
                      {
                        token: TOKEN_TO_ARBITRAGE,
                        encoded: [],
                      }
                    ).encoded,

                    TOKEN_TO_ARBITRAGE,
                    num.toHex(BigInt(split.specifiedAmount)),
                    "0x0",
                  ],
                },
                clearProfitsCall,
              ],
            };
          }
        }

        return {
          ...result,
          calls: [
            transferCall,
            {
              contractAddress: ROUTER_CONTRACT.address,
              entrypoint: "multi_multihop_swap",

              calldata: [
                num.toHex(splits.length),
                ...splits.reduce<string[]>((memo, split) => {
                  return memo.concat([
                    num.toHex(split.route.length),
                    ...split.route.reduce<{
                      token: string;
                      encoded: string[];
                    }>(
                      (memo, routeNode) => {
                        const isToken1 =
                          BigInt(memo.token) ===
                          BigInt(routeNode.pool_key.token1);

                        return {
                          token: isToken1
                            ? routeNode.pool_key.token0
                            : routeNode.pool_key.token1,
                          encoded: memo.encoded.concat([
                            routeNode.pool_key.token0,
                            routeNode.pool_key.token1,
                            routeNode.pool_key.fee,
                            num.toHex(routeNode.pool_key.tick_spacing),
                            routeNode.pool_key.extension,
                            num.toHex(
                              BigInt(routeNode.sqrt_ratio_limit) % 2n ** 128n
                            ),
                            num.toHex(
                              BigInt(routeNode.sqrt_ratio_limit) >> 128n
                            ),
                            routeNode.skip_ahead,
                          ]),
                        };
                      },
                      {
                        token: TOKEN_TO_ARBITRAGE,
                        encoded: [],
                      }
                    ).encoded,

                    TOKEN_TO_ARBITRAGE,
                    num.toHex(BigInt(split.specifiedAmount)),
                    "0x0",
                  ]);
                }, []),
              ],
            },
            clearProfitsCall,
          ],
        };
      });

    if (topArbitrageResults.length > 0) {
      console.log("Executing top arbitrage", topArbitrageResults[0]);

      const cost = await ACCOUNT.estimateFee(topArbitrageResults[0].calls);

      const { transaction_hash } = await ACCOUNT.execute(
        topArbitrageResults[0].calls,
        // double suggested max fee
        { maxFee: cost.suggestedMaxFee * 2n }
      );

      console.log(
        "Sent transaction, waiting for receipt",
        `${process.env.EXPLORER_TX_PREFIX}${transaction_hash}`
      );

      const receipt = await RPC_PROVIDER.waitForTransaction(transaction_hash, {
        retryInterval: 3_000,
      });

      console.log("Arbitrage receipt", receipt);
    }

    await sleep(CHECK_INTERVAL_MS);
  }
})()
  .then((result) => {
    console.log("Completed", result);
  })
  .catch((e) => {
    console.error("Errored", e);
  });
