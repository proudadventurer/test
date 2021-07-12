import {
  CollateralWhitelisted,
  ProductWhitelisted,
} from "../generated/Whitelist/Whitelist";
import { BigInt, Address, Bytes, BigDecimal } from "@graphprotocol/graph-ts";
import { Token, Underlying, Collateral } from "../generated/schema";
import { getTokenDecimals, getTokenName, getTokenSymbol } from "./tokenHelpers";
import { bigIntToDecimal } from "./helpers";

export const COLLATERAL_ID = "0";

export function getCollateralDecimals(): BigInt {
  const collateral = Collateral.load(COLLATERAL_ID);
  const token = Token.load(collateral.token);
  return token.decimals;
}

export function collateralFixedtoDecimals(value: BigInt): BigDecimal {
  const decimals = getCollateralDecimals();
  const decimalsInt = parseInt(decimals.toString());
  return bigIntToDecimal(value, decimalsInt as i32);
}

export function createTokenId(address: Bytes): string {
  return address.toHexString();
}

function createToken(address: Address): void {
  const tokenId = createTokenId(address as Bytes);
  let token = Token.load(tokenId);

  if (token == null) {
    token = new Token(tokenId);
    token.address = address;
    token.decimals = getTokenDecimals(address);
    token.name = getTokenName(address);
    token.symbol = getTokenSymbol(address);
    token.save();
  }
}

// Create an entity for the underlying of the product (if it does not exist already).
export function handleProductWhitelist(event: ProductWhitelisted): void {
  const underlyingAddress = event.params.underlying;
  createToken(underlyingAddress as Address);
  const tokenId = createTokenId(underlyingAddress as Bytes);
  let underlying = Underlying.load(tokenId);

  if (underlying == null) {
    underlying = new Underlying(tokenId);
    underlying.token = tokenId;
    underlying.save();
  }
}

// Create an entity for a collateral that is whitelisted.
export function handleCollateralWhitelist(event: CollateralWhitelisted): void {
  const collateralAddress = event.params.collateral;
  createToken(collateralAddress as Address);
  const tokenId = createTokenId(collateralAddress as Bytes);
  // Since we can only have one collateral token in the current
  // smart contracts architecture, fix the id to 0.
  let collateral = Collateral.load(COLLATERAL_ID);

  if (collateral == null) {
    collateral = new Collateral(COLLATERAL_ID);
    collateral.token = tokenId;
    collateral.save();
  }
}
