import "dotenv/config";
import { RpcProvider } from "starknet";

const EKUBO_API_QUOTE_URL = process.env.EKUBO_API_QUOTE_URL;
const TOKEN_TO_ARBITRAGE = process.env.TOKEN_TO_ARBITRAGE;
const MAX_HOPS = Math.max(2, Number(process.env.MAX_HOPS));
const MAX_SPLITS = Math.max(2, Number(process.env.MAX_SPLITS));
const CHECK_INTERVAL_MS = Math.max(3000, Number(process.env.CHECK_INTERVAL_MS));
const MIN_POWER_OF_2 = Math.max(32, Number(process.env.MIN_POWER_OF_2));
const MAX_POWER_OF_2 = Math.max(
  MIN_POWER_OF_2 + 1,
  Math.min(65, Number(process.env.MAX_POWER_OF_2))
);

const JSON_RPC_URL = process.env.JSON_RPC_URL;

const rpcProvider = new RpcProvider({
  nodeUrl: JSON_RPC_URL,
});

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
    const top5ArbitrageResults = (
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
      // filters to the profitable quotes
      .filter((quote): quote is Exclude<typeof quote, null> =>
        Boolean(quote && quote.profit > 0n)
      )
      .sort(({ profit: profitA }, { profit: profitB }) =>
        Number(profitB - profitA)
      )
      .slice(0, 5);

    console.log("Top 5", top5ArbitrageResults);

    // todo: execute

    await sleep(CHECK_INTERVAL_MS);
  }
})()
  .then((result) => {
    console.log("Completed", result);
  })
  .catch((e) => {
    console.error("Errored", e);
  });
