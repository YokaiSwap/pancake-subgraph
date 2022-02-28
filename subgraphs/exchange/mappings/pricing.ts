/* eslint-disable prefer-const */
import { BigDecimal, Address } from "@graphprotocol/graph-ts/index";
import { Pair, Token, Bundle } from "../generated/schema";
import { ZERO_BD, factoryContract, ADDRESS_ZERO, ONE_BD } from "./utils";

let WCKB_ADDRESS = "0xe934f463d026d97f6ce0a10215d0ac4224f0a930";
let USDC_WCKB_PAIR = "0x8ede6978c20d466b9e23cd7aa5ba8ab1708bc19e";

export function getNativeTokenPriceInUSD(): BigDecimal {
  // fetch native token prices for stablecoin
  let usdcPair = Pair.load(USDC_WCKB_PAIR); // usdc is token1

  if (usdcPair != null) {
    return usdcPair.token0Price;
  } else {
    return ZERO_BD;
  }
}

// token where amounts should contribute to tracked volume and liquidity
let WHITELIST: string[] = [
  "0xe934f463d026d97f6ce0a10215d0ac4224f0a930", // WCKB
  "0xc3b946c53e2e62200515d284249f2a91d9df7954", // USDC
  "0x07a388453944bb54be709ae505f14aeb5d5cbb2c", // USDT
  "0xb02c930c2825a960a50ba4ab005e8264498b64a0", // YOK
  "0x53a1964a163f64da59efe6a802e35b5529d078e2", // dCKB
  "0xf4187511d43b90751a28b6811d13afb49bef8452", // TAI
  "0x48aa6f7bee4c0d3e7d918833894ee83357ae0d4c", // ETH
];

// minimum liquidity for price to get tracked
let MINIMUM_LIQUIDITY_THRESHOLD_IN_NATIVE_TOKEN = BigDecimal.fromString("10");

/**
 * Search through graph to find derived Native Token per token.
 * @todo update to be derived Native Token (add stablecoin estimates)
 **/
export function findNativeTokenPerToken(token: Token): BigDecimal {
  if (token.id == WCKB_ADDRESS) {
    return ONE_BD;
  }
  // loop through whitelist and check if paired with any
  for (let i = 0; i < WHITELIST.length; ++i) {
    let pairAddress = factoryContract.getPair(Address.fromString(token.id), Address.fromString(WHITELIST[i]));
    if (pairAddress.toHex() != ADDRESS_ZERO) {
      let pair = Pair.load(pairAddress.toHex());
      if (pair.token0 == token.id && pair.reserveNative.gt(MINIMUM_LIQUIDITY_THRESHOLD_IN_NATIVE_TOKEN)) {
        let token1 = Token.load(pair.token1);
        return pair.token1Price.times(token1.derivedNative as BigDecimal); // return token1 per our token * Native Token per token 1
      }
      if (pair.token1 == token.id && pair.reserveNative.gt(MINIMUM_LIQUIDITY_THRESHOLD_IN_NATIVE_TOKEN)) {
        let token0 = Token.load(pair.token0);
        return pair.token0Price.times(token0.derivedNative as BigDecimal); // return token0 per our token * Native Token per token 0
      }
    }
  }
  return ZERO_BD; // nothing was found return 0
}

/**
 * Accepts tokens and amounts, return tracked amount based on token whitelist
 * If one token on whitelist, return amount in that token converted to USD.
 * If both are, return average of two amounts
 * If neither is, return 0
 */
export function getTrackedVolumeUSD(
  bundle: Bundle,
  tokenAmount0: BigDecimal,
  token0: Token,
  tokenAmount1: BigDecimal,
  token1: Token
): BigDecimal {
  let price0 = token0.derivedNative.times(bundle.nativeTokenPrice);
  let price1 = token1.derivedNative.times(bundle.nativeTokenPrice);

  // both are whitelist tokens, take average of both amounts
  if (WHITELIST.includes(token0.id) && WHITELIST.includes(token1.id)) {
    return tokenAmount0.times(price0).plus(tokenAmount1.times(price1)).div(BigDecimal.fromString("2"));
  }

  // take full value of the whitelisted token amount
  if (WHITELIST.includes(token0.id) && !WHITELIST.includes(token1.id)) {
    return tokenAmount0.times(price0);
  }

  // take full value of the whitelisted token amount
  if (!WHITELIST.includes(token0.id) && WHITELIST.includes(token1.id)) {
    return tokenAmount1.times(price1);
  }

  // neither token is on white list, tracked volume is 0
  return ZERO_BD;
}

/**
 * Accepts tokens and amounts, return tracked amount based on token whitelist
 * If one token on whitelist, return amount in that token converted to USD * 2.
 * If both are, return sum of two amounts
 * If neither is, return 0
 */
export function getTrackedLiquidityUSD(
  bundle: Bundle,
  tokenAmount0: BigDecimal,
  token0: Token,
  tokenAmount1: BigDecimal,
  token1: Token
): BigDecimal {
  let price0 = token0.derivedNative.times(bundle.nativeTokenPrice);
  let price1 = token1.derivedNative.times(bundle.nativeTokenPrice);

  // both are whitelist tokens, take average of both amounts
  if (WHITELIST.includes(token0.id) && WHITELIST.includes(token1.id)) {
    return tokenAmount0.times(price0).plus(tokenAmount1.times(price1));
  }

  // take double value of the whitelisted token amount
  if (WHITELIST.includes(token0.id) && !WHITELIST.includes(token1.id)) {
    return tokenAmount0.times(price0).times(BigDecimal.fromString("2"));
  }

  // take double value of the whitelisted token amount
  if (!WHITELIST.includes(token0.id) && WHITELIST.includes(token1.id)) {
    return tokenAmount1.times(price1).times(BigDecimal.fromString("2"));
  }

  // neither token is on white list, tracked volume is 0
  return ZERO_BD;
}
