/* eslint-disable prefer-const */
import { BigInt, BigDecimal, Address, TypedMap } from "@graphprotocol/graph-ts";
import { ERC20 } from "../../generated/Factory/ERC20";
import { Factory as FactoryContract } from "../../generated/templates/Pair/Factory";

export let ADDRESS_ZERO = "0x0000000000000000000000000000000000000000";
export let FACTORY_ADDRESS = "0x5ef0d2d41a5f3d5a083bc776f94282667c27b794";

export let ZERO_BI = BigInt.fromI32(0);
export let ONE_BI = BigInt.fromI32(1);
export let ZERO_BD = BigDecimal.fromString("0");
export let ONE_BD = BigDecimal.fromString("1");
export let BI_18 = BigInt.fromI32(18);

export let factoryContract = FactoryContract.bind(Address.fromString(FACTORY_ADDRESS));

export function exponentToBigDecimal(decimals: BigInt): BigDecimal {
  let bd = BigDecimal.fromString("1");
  for (let i = ZERO_BI; i.lt(decimals as BigInt); i = i.plus(ONE_BI)) {
    bd = bd.times(BigDecimal.fromString("10"));
  }
  return bd;
}

export function convertTokenToDecimal(tokenAmount: BigInt, exchangeDecimals: BigInt): BigDecimal {
  if (exchangeDecimals == ZERO_BI) {
    return tokenAmount.toBigDecimal();
  }
  return tokenAmount.toBigDecimal().div(exponentToBigDecimal(exchangeDecimals));
}

export function fetchTokenSymbol(tokenAddress: Address): string {
  let contract = ERC20.bind(tokenAddress);

  let symbolResult = contract.try_symbol();
  if (!symbolResult.reverted) {
    return symbolResult.value;
  }

  return "unknown";
}

export function fetchTokenName(tokenAddress: Address): string {
  let contract = ERC20.bind(tokenAddress);
  let nameResult = contract.try_name();
  if (!nameResult.reverted) {
    return nameResult.value;
  }

  return "unknown";
}

export let predefinedDecimalsByAddress = new TypedMap<string, BigInt>();
predefinedDecimalsByAddress.set("0xe934f463d026d97f6ce0a10215d0ac4224f0a930", BigInt.fromI32(8)); // WCKB
predefinedDecimalsByAddress.set("0x53a1964a163f64da59efe6a802e35b5529d078e2", BigInt.fromI32(8)); // dCKB
predefinedDecimalsByAddress.set("0xf4187511d43b90751a28b6811d13afb49bef8452", BigInt.fromI32(8)); // TAI

export function fetchTokenDecimals(tokenAddress: Address): BigInt {
  let predefinedDecimals = predefinedDecimalsByAddress.get(tokenAddress.toHex());
  if (predefinedDecimals != null) {
    return predefinedDecimals as BigInt;
  }

  let contract = ERC20.bind(tokenAddress);

  let decimalResult = contract.try_decimals();
  if (!decimalResult.reverted) {
    return BigInt.fromI32(decimalResult.value);
  }

  return BigInt.fromI32(18);
}
