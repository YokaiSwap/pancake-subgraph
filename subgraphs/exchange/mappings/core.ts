/* eslint-disable prefer-const */
import { BigInt, BigDecimal, store } from "@graphprotocol/graph-ts";
import {
  Pair,
  Token,
  YokaiFactory,
  Transaction,
  Mint as MintEvent,
  Burn as BurnEvent,
  Swap as SwapEvent,
  Bundle,
} from "../generated/schema";
import { Mint, Burn, Swap, Transfer, Sync } from "../generated/templates/Pair/Pair";
import { updatePairDayData, updateTokenDayData, updateYokaiDayData, updatePairHourData } from "./dayUpdates";
import {
  getNativeTokenPriceInUSD,
  findNativeTokenPerToken,
  getTrackedVolumeUSD,
  getTrackedLiquidityUSD,
} from "./pricing";
import { convertTokenToDecimal, ADDRESS_ZERO, FACTORY_ADDRESS, ONE_BI, ZERO_BD, BI_18 } from "./utils";

function isCompleteMint(mintId: string): boolean {
  return MintEvent.load(mintId).sender !== null; // sufficient checks
}

export function handleTransfer(event: Transfer): void {
  // Initial liquidity.
  if (event.params.to.toHex() == ADDRESS_ZERO && event.params.value.equals(BigInt.fromI32(1000))) {
    return;
  }

  // get pair and load contract
  let pair = Pair.load(event.address.toHex());

  // liquidity token amount being transferred
  let value = convertTokenToDecimal(event.params.value, BI_18);

  // get or create transaction
  let transaction = Transaction.load(event.transaction.hash.toHex());
  if (transaction === null) {
    transaction = new Transaction(event.transaction.hash.toHex());
    transaction.block = event.block.number;
    transaction.timestamp = event.block.timestamp;
    transaction.mints = [];
    transaction.burns = [];
    transaction.swaps = [];
  }

  // mints
  let mints = transaction.mints;
  if (event.params.from.toHex() == ADDRESS_ZERO) {
    // update total supply
    pair.totalSupply = pair.totalSupply.plus(value);
    pair.save();

    // create new mint if no mints so far or if last one is done already
    if (mints.length === 0 || isCompleteMint(mints[mints.length - 1])) {
      let mint = new MintEvent(
        event.transaction.hash.toHex().concat("-").concat(BigInt.fromI32(mints.length).toString())
      );
      mint.transaction = transaction.id;
      mint.pair = pair.id;
      mint.to = event.params.to;
      mint.liquidity = value;
      mint.timestamp = transaction.timestamp;
      mint.transaction = transaction.id;
      mint.token0 = pair.token0;
      mint.token1 = pair.token1;
      mint.save();

      // update mints in transaction
      transaction.mints = mints.concat([mint.id]);

      // save entities
      transaction.save();
    }
  }

  // case where direct send first on Native Token withdrawals
  if (event.params.to.toHex() == pair.id) {
    let burns = transaction.burns;
    let burn = new BurnEvent(
      event.transaction.hash.toHex().concat("-").concat(BigInt.fromI32(burns.length).toString())
    );
    burn.transaction = transaction.id;
    burn.pair = pair.id;
    burn.liquidity = value;
    burn.timestamp = transaction.timestamp;
    burn.to = event.params.to;
    burn.sender = event.params.from;
    burn.needsComplete = true;
    burn.transaction = transaction.id;
    burn.token0 = pair.token0;
    burn.token1 = pair.token1;
    burn.save();

    // TODO: Consider using .concat() for handling array updates to protect
    // against unintended side effects for other code paths.
    burns.push(burn.id);
    transaction.burns = burns;
    transaction.save();
  }

  // burn
  if (event.params.to.toHex() == ADDRESS_ZERO && event.params.from.toHex() == pair.id) {
    pair.totalSupply = pair.totalSupply.minus(value);
    pair.save();

    // this is a new instance of a logical burn
    let burns = transaction.burns;
    let burn: BurnEvent;
    if (burns.length > 0) {
      let currentBurn = BurnEvent.load(burns[burns.length - 1]);
      if (currentBurn.needsComplete) {
        burn = currentBurn as BurnEvent;
      } else {
        burn = new BurnEvent(
          event.transaction.hash.toHex().concat("-").concat(BigInt.fromI32(burns.length).toString())
        );
        burn.transaction = transaction.id;
        burn.needsComplete = false;
        burn.pair = pair.id;
        burn.liquidity = value;
        burn.transaction = transaction.id;
        burn.timestamp = transaction.timestamp;
        burn.token0 = pair.token0;
        burn.token1 = pair.token1;
      }
    } else {
      burn = new BurnEvent(event.transaction.hash.toHex().concat("-").concat(BigInt.fromI32(burns.length).toString()));
      burn.transaction = transaction.id;
      burn.needsComplete = false;
      burn.pair = pair.id;
      burn.liquidity = value;
      burn.transaction = transaction.id;
      burn.timestamp = transaction.timestamp;
      burn.token0 = pair.token0;
      burn.token1 = pair.token1;
    }

    // if this logical burn included a fee mint, account for this
    if (mints.length !== 0 && !isCompleteMint(mints[mints.length - 1])) {
      let mint = MintEvent.load(mints[mints.length - 1]);
      burn.feeTo = mint.to;
      burn.feeLiquidity = mint.liquidity;
      // remove the logical mint
      store.remove("Mint", mints[mints.length - 1]);
      // update the transaction

      // TODO: Consider using .slice().pop() to protect against unintended
      // side effects for other code paths.
      mints.pop();
      transaction.mints = mints;
      transaction.save();
    }
    burn.save();
    // if accessing last one, replace it
    if (burn.needsComplete) {
      // TODO: Consider using .slice(0, -1).concat() to protect against
      // unintended side effects for other code paths.
      burns[burns.length - 1] = burn.id;
    }
    // else add new one
    else {
      // TODO: Consider using .concat() for handling array updates to protect
      // against unintended side effects for other code paths.
      burns.push(burn.id);
    }
    transaction.burns = burns;
    transaction.save();
  }

  transaction.save();
}

export function handleSync(event: Sync): void {
  let pair = Pair.load(event.address.toHex());
  let token0 = Token.load(pair.token0);
  let token1 = Token.load(pair.token1);
  let factory = YokaiFactory.load(FACTORY_ADDRESS);

  // reset factory liquidity by subtracting only tracked liquidity
  factory.totalLiquidityNative = factory.totalLiquidityNative.minus(pair.trackedReserveNative as BigDecimal);

  // reset token total liquidity amounts
  token0.totalLiquidity = token0.totalLiquidity.minus(pair.reserve0);
  token1.totalLiquidity = token1.totalLiquidity.minus(pair.reserve1);

  pair.reserve0 = convertTokenToDecimal(event.params.reserve0, token0.decimals);
  pair.reserve1 = convertTokenToDecimal(event.params.reserve1, token1.decimals);

  if (pair.reserve1.notEqual(ZERO_BD)) pair.token0Price = pair.reserve0.div(pair.reserve1);
  else pair.token0Price = ZERO_BD;
  if (pair.reserve0.notEqual(ZERO_BD)) pair.token1Price = pair.reserve1.div(pair.reserve0);
  else pair.token1Price = ZERO_BD;

  let bundle = Bundle.load("1");
  bundle.nativeTokenPrice = getNativeTokenPriceInUSD();
  bundle.save();

  let t0DerivedNative = findNativeTokenPerToken(token0 as Token);
  token0.derivedNative = t0DerivedNative;
  token0.derivedUSD = t0DerivedNative.times(bundle.nativeTokenPrice);
  token0.save();

  let t1DerivedNative = findNativeTokenPerToken(token1 as Token);
  token1.derivedNative = t1DerivedNative;
  token1.derivedUSD = t1DerivedNative.times(bundle.nativeTokenPrice);
  token1.save();

  // get tracked liquidity - will be 0 if neither is in whitelist
  let trackedLiquidityNative: BigDecimal;
  if (bundle.nativeTokenPrice.notEqual(ZERO_BD)) {
    trackedLiquidityNative = getTrackedLiquidityUSD(
      bundle as Bundle,
      pair.reserve0,
      token0 as Token,
      pair.reserve1,
      token1 as Token
    ).div(bundle.nativeTokenPrice);
  } else {
    trackedLiquidityNative = ZERO_BD;
  }

  // use derived amounts within pair
  pair.trackedReserveNative = trackedLiquidityNative;
  pair.reserveNative = pair.reserve0
    .times(token0.derivedNative as BigDecimal)
    .plus(pair.reserve1.times(token1.derivedNative as BigDecimal));
  pair.reserveUSD = pair.reserveNative.times(bundle.nativeTokenPrice);

  // use tracked amounts globally
  factory.totalLiquidityNative = factory.totalLiquidityNative.plus(trackedLiquidityNative);
  factory.totalLiquidityUSD = factory.totalLiquidityNative.times(bundle.nativeTokenPrice);

  // now correctly set liquidity amounts for each token
  token0.totalLiquidity = token0.totalLiquidity.plus(pair.reserve0);
  token1.totalLiquidity = token1.totalLiquidity.plus(pair.reserve1);

  // save entities
  pair.save();
  factory.save();
  token0.save();
  token1.save();
}

export function handleMint(event: Mint): void {
  let transaction = Transaction.load(event.transaction.hash.toHex());
  let mints = transaction.mints;
  let mint = MintEvent.load(mints[mints.length - 1]);

  let pair = Pair.load(event.address.toHex());
  let factory = YokaiFactory.load(FACTORY_ADDRESS);

  let token0 = Token.load(pair.token0);
  let token1 = Token.load(pair.token1);

  // update exchange info (except balances, sync will cover that)
  let token0Amount = convertTokenToDecimal(event.params.amount0, token0.decimals);
  let token1Amount = convertTokenToDecimal(event.params.amount1, token1.decimals);

  // update txn counts
  token0.totalTransactions = token0.totalTransactions.plus(ONE_BI);
  token1.totalTransactions = token1.totalTransactions.plus(ONE_BI);

  // get new amounts of USD and Native for tracking
  let bundle = Bundle.load("1");
  let amountTotalUSD = token1.derivedNative
    .times(token1Amount)
    .plus(token0.derivedNative.times(token0Amount))
    .times(bundle.nativeTokenPrice);

  // update txn counts
  pair.totalTransactions = pair.totalTransactions.plus(ONE_BI);
  factory.totalTransactions = factory.totalTransactions.plus(ONE_BI);

  // save entities
  token0.save();
  token1.save();
  pair.save();
  factory.save();

  mint.sender = event.params.sender;
  mint.amount0 = token0Amount as BigDecimal;
  mint.amount1 = token1Amount as BigDecimal;
  mint.logIndex = event.logIndex;
  mint.amountUSD = amountTotalUSD as BigDecimal;
  mint.save();

  updatePairDayData(event);
  updatePairHourData(event);
  updateYokaiDayData(event);
  updateTokenDayData(token0 as Token, event);
  updateTokenDayData(token1 as Token, event);
}

export function handleBurn(event: Burn): void {
  let transaction = Transaction.load(event.transaction.hash.toHex());
  if (transaction === null) {
    return;
  }

  let burns = transaction.burns;
  let burn = BurnEvent.load(burns[burns.length - 1]);

  let pair = Pair.load(event.address.toHex());
  let factory = YokaiFactory.load(FACTORY_ADDRESS);

  //update token info
  let token0 = Token.load(pair.token0);
  let token1 = Token.load(pair.token1);
  let token0Amount = convertTokenToDecimal(event.params.amount0, token0.decimals);
  let token1Amount = convertTokenToDecimal(event.params.amount1, token1.decimals);

  // update txn counts
  token0.totalTransactions = token0.totalTransactions.plus(ONE_BI);
  token1.totalTransactions = token1.totalTransactions.plus(ONE_BI);

  // get new amounts of USD and Native for tracking
  let bundle = Bundle.load("1");
  let amountTotalUSD = token1.derivedNative
    .times(token1Amount)
    .plus(token0.derivedNative.times(token0Amount))
    .times(bundle.nativeTokenPrice);

  // update txn counts
  factory.totalTransactions = factory.totalTransactions.plus(ONE_BI);
  pair.totalTransactions = pair.totalTransactions.plus(ONE_BI);

  // update global counter and save
  token0.save();
  token1.save();
  pair.save();
  factory.save();

  // update burn
  // burn.sender = event.params.sender
  burn.amount0 = token0Amount as BigDecimal;
  burn.amount1 = token1Amount as BigDecimal;
  // burn.to = event.params.to
  burn.logIndex = event.logIndex;
  burn.amountUSD = amountTotalUSD as BigDecimal;
  burn.save();

  updatePairDayData(event);
  updatePairHourData(event);
  updateYokaiDayData(event);
  updateTokenDayData(token0 as Token, event);
  updateTokenDayData(token1 as Token, event);
}

export function handleSwap(event: Swap): void {
  let pair = Pair.load(event.address.toHex());
  let token0 = Token.load(pair.token0);
  let token1 = Token.load(pair.token1);
  let amount0In = convertTokenToDecimal(event.params.amount0In, token0.decimals);
  let amount1In = convertTokenToDecimal(event.params.amount1In, token1.decimals);
  let amount0Out = convertTokenToDecimal(event.params.amount0Out, token0.decimals);
  let amount1Out = convertTokenToDecimal(event.params.amount1Out, token1.decimals);

  // totals for volume updates
  let amount0Total = amount0Out.plus(amount0In);
  let amount1Total = amount1Out.plus(amount1In);

  // Native/USD prices
  let bundle = Bundle.load("1");

  // get total amounts of derived USD and Native for tracking
  let derivedAmountNative = token1.derivedNative
    .times(amount1Total)
    .plus(token0.derivedNative.times(amount0Total))
    .div(BigDecimal.fromString("2"));
  let derivedAmountUSD = derivedAmountNative.times(bundle.nativeTokenPrice);

  // only accounts for volume through white listed tokens
  let trackedAmountUSD = getTrackedVolumeUSD(
    bundle as Bundle,
    amount0Total,
    token0 as Token,
    amount1Total,
    token1 as Token
  );

  let trackedAmountNative: BigDecimal;
  if (bundle.nativeTokenPrice.equals(ZERO_BD)) {
    trackedAmountNative = ZERO_BD;
  } else {
    trackedAmountNative = trackedAmountUSD.div(bundle.nativeTokenPrice);
  }

  // update token0 global volume and token liquidity stats
  token0.tradeVolume = token0.tradeVolume.plus(amount0In.plus(amount0Out));
  token0.tradeVolumeUSD = token0.tradeVolumeUSD.plus(trackedAmountUSD);
  token0.untrackedVolumeUSD = token0.untrackedVolumeUSD.plus(derivedAmountUSD);

  // update token1 global volume and token liquidity stats
  token1.tradeVolume = token1.tradeVolume.plus(amount1In.plus(amount1Out));
  token1.tradeVolumeUSD = token1.tradeVolumeUSD.plus(trackedAmountUSD);
  token1.untrackedVolumeUSD = token1.untrackedVolumeUSD.plus(derivedAmountUSD);

  // update txn counts
  token0.totalTransactions = token0.totalTransactions.plus(ONE_BI);
  token1.totalTransactions = token1.totalTransactions.plus(ONE_BI);

  // update pair volume data, use tracked amount if we have it as its probably more accurate
  pair.volumeUSD = pair.volumeUSD.plus(trackedAmountUSD);
  pair.volumeToken0 = pair.volumeToken0.plus(amount0Total);
  pair.volumeToken1 = pair.volumeToken1.plus(amount1Total);
  pair.untrackedVolumeUSD = pair.untrackedVolumeUSD.plus(derivedAmountUSD);
  pair.totalTransactions = pair.totalTransactions.plus(ONE_BI);
  pair.save();

  // update global values, only used tracked amounts for volume
  let factory = YokaiFactory.load(FACTORY_ADDRESS);
  factory.totalVolumeUSD = factory.totalVolumeUSD.plus(trackedAmountUSD);
  factory.totalVolumeNative = factory.totalVolumeNative.plus(trackedAmountNative);
  factory.untrackedVolumeUSD = factory.untrackedVolumeUSD.plus(derivedAmountUSD);
  factory.totalTransactions = factory.totalTransactions.plus(ONE_BI);

  // save entities
  pair.save();
  token0.save();
  token1.save();
  factory.save();

  let transaction = Transaction.load(event.transaction.hash.toHex());
  if (transaction === null) {
    transaction = new Transaction(event.transaction.hash.toHex());
    transaction.block = event.block.number;
    transaction.timestamp = event.block.timestamp;
    transaction.mints = [];
    transaction.swaps = [];
    transaction.burns = [];
  }
  let swaps = transaction.swaps;
  let swap = new SwapEvent(event.transaction.hash.toHex().concat("-").concat(BigInt.fromI32(swaps.length).toString()));

  // update swap event
  swap.transaction = transaction.id;
  swap.pair = pair.id;
  swap.timestamp = transaction.timestamp;
  swap.transaction = transaction.id;
  swap.sender = event.params.sender;
  swap.amount0In = amount0In;
  swap.amount1In = amount1In;
  swap.amount0Out = amount0Out;
  swap.amount1Out = amount1Out;
  swap.to = event.params.to;
  swap.from = event.transaction.from;
  swap.logIndex = event.logIndex;
  // use the tracked amount if we have it
  swap.amountUSD = trackedAmountUSD === ZERO_BD ? derivedAmountUSD : trackedAmountUSD;
  swap.token0 = pair.token0;
  swap.token1 = pair.token1;
  swap.save();

  // update the transaction

  // TODO: Consider using .concat() for handling array updates to protect
  // against unintended side effects for other code paths.
  swaps.push(swap.id);
  transaction.swaps = swaps;
  transaction.save();

  // update day entities
  let pairDayData = updatePairDayData(event);
  let pairHourData = updatePairHourData(event);
  let yokaiDayData = updateYokaiDayData(event);
  let token0DayData = updateTokenDayData(token0 as Token, event);
  let token1DayData = updateTokenDayData(token1 as Token, event);

  // swap specific updating
  yokaiDayData.dailyVolumeUSD = yokaiDayData.dailyVolumeUSD.plus(trackedAmountUSD);
  yokaiDayData.dailyVolumeNative = yokaiDayData.dailyVolumeNative.plus(trackedAmountNative);
  yokaiDayData.dailyVolumeUntracked = yokaiDayData.dailyVolumeUntracked.plus(derivedAmountUSD);
  yokaiDayData.save();

  // swap specific updating for pair
  pairDayData.dailyVolumeToken0 = pairDayData.dailyVolumeToken0.plus(amount0Total);
  pairDayData.dailyVolumeToken1 = pairDayData.dailyVolumeToken1.plus(amount1Total);
  pairDayData.dailyVolumeUSD = pairDayData.dailyVolumeUSD.plus(trackedAmountUSD);
  pairDayData.save();

  // update hourly pair data
  pairHourData.hourlyVolumeToken0 = pairHourData.hourlyVolumeToken0.plus(amount0Total);
  pairHourData.hourlyVolumeToken1 = pairHourData.hourlyVolumeToken1.plus(amount1Total);
  pairHourData.hourlyVolumeUSD = pairHourData.hourlyVolumeUSD.plus(trackedAmountUSD);
  pairHourData.save();

  // swap specific updating for token0
  token0DayData.dailyVolumeToken = token0DayData.dailyVolumeToken.plus(amount0Total);
  token0DayData.dailyVolumeNative = token0DayData.dailyVolumeNative.plus(
    amount0Total.times(token0.derivedNative as BigDecimal)
  );
  token0DayData.dailyVolumeUSD = token0DayData.dailyVolumeUSD.plus(
    amount0Total.times(token0.derivedNative as BigDecimal).times(bundle.nativeTokenPrice)
  );
  token0DayData.save();

  // swap specific updating
  token1DayData.dailyVolumeToken = token1DayData.dailyVolumeToken.plus(amount1Total);
  token1DayData.dailyVolumeNative = token1DayData.dailyVolumeNative.plus(
    amount1Total.times(token1.derivedNative as BigDecimal)
  );
  token1DayData.dailyVolumeUSD = token1DayData.dailyVolumeUSD.plus(
    amount1Total.times(token1.derivedNative as BigDecimal).times(bundle.nativeTokenPrice)
  );
  token1DayData.save();
}
