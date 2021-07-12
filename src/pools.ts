import { BigInt, BigDecimal, Bytes } from "@graphprotocol/graph-ts";
import {
  Deposited,
  OptionsBought,
  OptionsSold,
  Withdrawn,
  OptionSettlementDistributed,
  CriteriaSetSelected,
  CurveSelected,
  OptionSettled,
} from "../generated/LiquidityPool/LiquidityPool";
import {
  Pool,
  BuyerRecord,
  LPRecord,
  PoolSnapshot,
  Template,
  PoolRecord,
  OrderBookEntry,
} from "../generated/schema";
import { collateralFixedtoDecimals } from "./token";
import {
  oTokenFixedtoDecimals,
  oTokenSettled,
  oTokenIncrementLiquidity,
  oTokenIncrementPurchasesCount,
  getOTokenIdFromAddress,
} from "./otoken";

const ONE_BIGINT = BigInt.fromI32(1);

// Have to manually define this Enum since codegen schema does not contain Enums
export enum Actions {
  CURVE_CHANGE = -2,
  CRITERIASET_CHANGE = -1,
  DEPOSIT = 0,
  WITHDRAW = 1,
  PREMIUM_RECIEVED = 2,
  CAPITAL_EXERCISED = 3,
}

function createPoolId(lp: Bytes, poolId: BigInt): string {
  return lp.toHexString() + poolId.toHexString();
}

function createPoolSnapshotId(
  lp: Bytes,
  poolId: BigInt,
  timestamp: BigInt
): string {
  return lp.toHexString() + poolId.toHexString() + timestamp.toHexString();
}

function createTemplateId(curveHash: Bytes, criteriaSetHash: Bytes): string {
  return curveHash.toHexString() + criteriaSetHash.toHexString();
}

function createLPRecordID(lp: Bytes, otoken: Bytes): string {
  return lp.toHexString() + otoken.toHexString();
}

function createPoolRecordID(lp: Bytes, poolId: BigInt, otoken: Bytes): string {
  return lp.toHexString() + poolId.toHexString() + otoken.toHexString();
}

/*
This function is used to change the amount of capital within the
template in response to a Deposit, Withdraw, Receiving Premium, or
having a option exercised against a pool that exists within the template.
*/
function updateCapitalTemplate(
  pool: Pool,
  actionAmount: BigDecimal,
  actionType: Actions
): void {
  if (pool.template != null) {
    const template = Template.load(pool.template);
    template.pnl = calculatePNL(template.pnl, actionAmount, actionType);

    switch (actionType) {
      case Actions.DEPOSIT:
        template.size = template.size.plus(actionAmount);
        break;
      case Actions.WITHDRAW:
        template.size = template.size.minus(actionAmount);
        break;
      case Actions.PREMIUM_RECIEVED:
        template.size = template.size.plus(actionAmount);
        break;
      case Actions.CAPITAL_EXERCISED:
        template.size = template.size.minus(actionAmount);
        break;
    }
    template.save();
  }
}

/*
This function is called when there is a change in a pools curveHash or criteriaSetHash.

This function is responsible for creating or loading the new template into the pool's template
field. It also changes the values in the old and new template to reflect the change in capital
and count of pools.
*/
function updateConfigPoolTemplate(
  pool: Pool,
  pastTemplate: Template,
  curveHash: string,
  criteriaSetHash: string
): void {
  // Case where the old template was null or different from the current settings
  if (
    pastTemplate.curve !== curveHash ||
    pastTemplate.criteriaSet !== criteriaSetHash ||
    pastTemplate == null
  ) {
    const templateId = createTemplateId(
      Bytes.fromHexString(curveHash) as Bytes,
      Bytes.fromHexString(criteriaSetHash) as Bytes
    );
    let template = Template.load(templateId);

    // If the template does not exist, create a new one
    if (template == null) {
      template = new Template(templateId);
      template.size = BigDecimal.fromString("0"); //pool.size;
      template.numPools = BigInt.fromI32(0);
      template.curve = curveHash;
      template.criteriaSet = criteriaSetHash;
      template.pnl = BigDecimal.fromString("0");
    }
    // increment template's fields to represent the new pool joining.
    template.numPools = template.numPools.plus(ONE_BIGINT);
    template.size = template.size.plus(pool.size);
    template.save();
    // Set the pool to use the new / loaded template
    pool.template = template.id;

    // Change the values in the past template to account for the change in pool's template
    if (pastTemplate != null) {
      pastTemplate.numPools = pastTemplate.numPools.minus(ONE_BIGINT);
      pastTemplate.size = pastTemplate.size.minus(pool.size);
      pastTemplate.save();
    }
    pool.pnlTemplate = BigDecimal.fromString("0");
    pool.save();
  }
}

/**
 * Creates a Pool Snapshot entity, called when a pool is updated.
 * @param {Pool} pool Pool instance.
 * @param {BigInt} timestamp Timestamp of the transaction, epoch in seconds.
 * @param {BigDecimal} actionAmount Amount to increment or decrement the pool size
 * or locked by.
 * @param {string} actionType Enumerated action value.
 */
export function createPoolSnapshot(
  pool: Pool,
  timestamp: BigInt,
  actionAmount: BigDecimal,
  actionType: Actions
): void {
  const poolSnapshotId = createPoolSnapshotId(pool.lp, pool.poolId, timestamp);
  const poolSnapshot = new PoolSnapshot(poolSnapshotId);

  poolSnapshot.poolId = pool.poolId;
  poolSnapshot.lp = pool.lp;
  poolSnapshot.size = pool.size;
  poolSnapshot.locked = pool.locked;
  poolSnapshot.unlocked = pool.unlocked;
  poolSnapshot.utilization = pool.utilization;
  poolSnapshot.template = pool.template;
  poolSnapshot.timestamp = timestamp;
  poolSnapshot.actionAmount = actionAmount;
  poolSnapshot.actionType = BigInt.fromI32(actionType);
  poolSnapshot.currentPool = pool.id;
  poolSnapshot.pnlTotal = pool.pnlTotal;
  poolSnapshot.pnlTemplate = pool.pnlTemplate;
  poolSnapshot.pnlPercentage = pool.pnlPercentage;
  poolSnapshot.netDeposits = pool.netDeposits;
  poolSnapshot.initialBalance = pool.initialBalance;

  poolSnapshot.save();

  updateCapitalTemplate(pool, actionAmount, actionType);
}

function createPool(poolUUID: string, lp: Bytes, poolId: BigInt): Pool {
  const pool = new Pool(poolUUID);
  pool.locked = BigDecimal.fromString("0");
  pool.size = BigDecimal.fromString("0");
  pool.unlocked = BigDecimal.fromString("0");
  pool.utilization = BigDecimal.fromString("0");
  pool.netDeposits = BigDecimal.fromString("0");
  pool.pnlPercentage = BigDecimal.fromString("0");
  pool.lp = lp;
  pool.poolId = poolId;
  pool.pnlTotal = BigDecimal.fromString("0");
  pool.pnlTemplate = BigDecimal.fromString("0");
  return pool;
}

/**
 * Function uses the amount of collateral added/removed from the event to calculate
   the updated Profit & Loss for the entity (pool or template).
 * @param {BigDecimal} currentPNL Current P&L for the entity.
 * @param {BigDecimal} actionAmount Amount to increment or decrement the P&L by.
 * @param {string} actionType Enumerated action value.
 * @return {BigDecimal} The re-calculated Profit & Loss.
 */
function calculatePNL(
  currentPNL: BigDecimal,
  actionAmount: BigDecimal,
  actionType: Actions
): BigDecimal {
  let updatedPNL: BigDecimal = BigDecimal.fromString("0");
  switch (actionType) {
    case Actions.PREMIUM_RECIEVED:
      updatedPNL = currentPNL.plus(actionAmount);
      break;
    case Actions.CAPITAL_EXERCISED:
      updatedPNL = currentPNL.minus(actionAmount);
      break;
    default:
      updatedPNL = currentPNL;
  }
  return updatedPNL;
}

/**
 * Calculate the net deposits, or the sum of all deposits minus all withdraws.
 * @param {BigDecimal} netDeposits Current Net Deposits for the pool.
 * @param {BigDecimal} actionAmount Amount to increment or decrement the P&L by.
 * @param {string} actionType Enumerated action value.
 * @return {BigDecimal} The re-calculated Profit & Loss.
 */
function calculateNetDeposits(
  netDeposits: BigDecimal,
  actionAmount: BigDecimal,
  actionType: Actions
): BigDecimal {
  let updatedNetDeposits: BigDecimal = BigDecimal.fromString("0");
  switch (actionType) {
    case Actions.DEPOSIT:
      updatedNetDeposits = netDeposits.plus(actionAmount);
      break;
    case Actions.WITHDRAW:
      updatedNetDeposits = netDeposits.minus(actionAmount);
      break;
    default:
      updatedNetDeposits = netDeposits;
  }
  return updatedNetDeposits;
}

/**
 * Uses the action and liquidity added/removed from the pool to change the P&L values.
 * @param {BigDecimal} currentPNL Current P&L for the entity.
 * @param {BigDecimal} actionAmount Amount to increment or decrement the P&L by.
 * @param {string} actionType Enumerated action value.
 * @param {Pool} pool Pool object.
 */
function setAndCalculatePNL(
  actionAmount: BigDecimal,
  actionType: Actions,
  pool: Pool
): void {
  pool.pnlTotal = calculatePNL(pool.pnlTotal, actionAmount, actionType);
  pool.pnlTemplate = calculatePNL(pool.pnlTemplate, actionAmount, actionType);

  const BIGDECIMAL_ONE = BigDecimal.fromString("1");
  const BIGDECIMAL_HUNDRED = BigDecimal.fromString("100");
  const pnlDecimal = pool.size
    .minus(pool.netDeposits)
    .div(pool.initialBalance as BigDecimal)
    .minus(BIGDECIMAL_ONE);
  pool.pnlPercentage = pnlDecimal.times(BIGDECIMAL_HUNDRED);
  pool.save();
}

/**
 * Creates an OrderBookEntry from the buyer address, oToken address, and timestamp.
   Modifies Entities: OrderBookEntry
 * @param {Bytes} buyer The buyer's address.
 * @param {Bytes} otoken The oToken's adddress.
 * @param {BigDecimal} premium The premium paid by the buyer for oTokens purchased.
 * @param {BigDecimal} tokens The number of oTokens purchased by the buyer.
 * @param {BigInt} timestamp The timestamp of the block, given as an epoch in seconds.
 * @return {void}
 */
function createOrderBookEntry(
  buyer: Bytes,
  otoken: Bytes,
  premium: BigDecimal,
  tokens: BigDecimal,
  timestamp: BigInt
): void {
  const entryId =
    buyer.toHexString() + otoken.toHexString() + timestamp.toString();
  const entry = new OrderBookEntry(entryId);

  entry.buyer = buyer;
  // to set field to an entity, set to the string of the entity's ID.
  entry.otoken = getOTokenIdFromAddress(otoken);
  entry.premium = premium;
  entry.numberOfOTokens = tokens;
  entry.timestamp = timestamp;
  entry.save();
}

/**
 * Called when a Deposited event is emitted. Changes the size of the pool for the
 * deposit amount, or creates a new pool
 * @param {Deposited} event Descriptor of the event emitted.
 */
export function handleDeposited(event: Deposited): void {
  //Deposited(address indexed lp, uint256 indexed poolId, uint256 amount);
  const poolId = createPoolId(event.params.lp, event.params.poolId);
  let pool = Pool.load(poolId);
  if (pool == null) {
    pool = createPool(poolId, event.params.lp, event.params.poolId);
  }
  const tokenAmount = collateralFixedtoDecimals(event.params.amount);

  pool.size = pool.size.plus(tokenAmount);
  pool.unlocked = pool.unlocked.plus(tokenAmount);

  if (!pool.initialBalance)
    // If this is the first deposit for the pool
    pool.initialBalance = pool.size;
  // Not the first deposit for the pool
  else
    pool.netDeposits = calculateNetDeposits(
      pool.netDeposits,
      tokenAmount,
      Actions.DEPOSIT
    );
  pool.save();

  setAndCalculatePNL(tokenAmount, Actions.DEPOSIT, pool as Pool);

  if (pool)
    createPoolSnapshot(
      pool as Pool,
      event.block.timestamp,
      tokenAmount,
      Actions.DEPOSIT
    );
}

/**
 * Called when a Withdrawn event is emitted. Changes the size of the pool for the
 * amount removed.
 * @param {Withdrawn} event Descriptor of the event emitted.
 */
export function handleWithdrawn(event: Withdrawn): void {
  const poolId = createPoolId(event.params.lp, event.params.poolId);
  let pool = Pool.load(poolId);
  if (pool == null) {
    pool = createPool(poolId, event.params.lp, event.params.poolId);
  }

  const withdrawlAmount = collateralFixedtoDecimals(event.params.amount);
  pool.size = pool.size.minus(withdrawlAmount);
  pool.unlocked = pool.unlocked.minus(withdrawlAmount);

  pool.netDeposits = calculateNetDeposits(
    pool.netDeposits,
    withdrawlAmount,
    Actions.WITHDRAW
  );
  pool.save();

  setAndCalculatePNL(withdrawlAmount, Actions.WITHDRAW, pool as Pool);

  if (pool)
    createPoolSnapshot(
      pool as Pool,
      event.block.timestamp,
      withdrawlAmount,
      Actions.WITHDRAW
    );
}

/**
 * Called when a CriteriaSetSelected event is emitted. Changes the CriteriaSet
   for the pool and updates the template associated with the pool.
 * @param {CriteriaSetSelected} event Descriptor of the event emitted.
 */
export function handleCriteriaSetSelected(event: CriteriaSetSelected): void {
  const poolId = createPoolId(event.params.lp, event.params.poolId);
  const pool = Pool.load(poolId);
  const template = Template.load(pool.template);
  const criteriaSetHashId = event.params.criteriaSetHash.toHexString();

  if (pool.template == null) {
    updateConfigPoolTemplate(pool as Pool, null, null, criteriaSetHashId);
  } else {
    updateConfigPoolTemplate(
      pool as Pool,
      template as Template,
      template.curve,
      criteriaSetHashId
    );
  }

  createPoolSnapshot(
    pool as Pool,
    event.block.timestamp,
    BigDecimal.fromString("0"),
    Actions.CRITERIASET_CHANGE
  );
}

/**
 * Called when a CurveSelected event is emitted. Changes the Curve
   for the pool and updates the template associated with the pool.
 * @param {CurveSelected} event Descriptor of the event emitted.
 */
export function handleCurveSelected(event: CurveSelected): void {
  const poolId = createPoolId(event.params.lp, event.params.poolId);
  let pool = Pool.load(poolId);
  if (pool == null) {
    pool = createPool(poolId, event.params.lp, event.params.poolId);
  }
  const template = Template.load(pool.template);
  const curveId = event.params.curveHash.toHexString();

  if (pool.template == null) {
    updateConfigPoolTemplate(pool as Pool, null, curveId, null);
  } else {
    updateConfigPoolTemplate(
      pool as Pool,
      template as Template,
      curveId,
      template.criteriaSet
    );
  }

  createPoolSnapshot(
    pool as Pool,
    event.block.timestamp,
    BigDecimal.fromString("0"),
    Actions.CURVE_CHANGE
  );
}

/**
 * Called when a buyer purchases oTokens from at least one LP.
 * Updates the BuyerRecord based on the order.
 * Modifies Entities: BuyerRecord, OToken, OrderBookEntry.
 * @param {OptionsBought} event Data for OptionsBought event.
 * @return {void}
 */
export function handleOptionsBought(event: OptionsBought): void {
  const recordID =
    event.params.buyer.toHexString() + event.params.otoken.toHexString();
  let record = BuyerRecord.load(recordID);
  const tokenAmount = oTokenFixedtoDecimals(
    event.params.otoken,
    event.params.numberOfOtokens
  );
  const premiumPaid = collateralFixedtoDecimals(event.params.totalPremiumPaid);
  if (record == null) {
    record = new BuyerRecord(recordID);
    record.buyer = event.params.buyer;
    record.otoken = getOTokenIdFromAddress(event.params.otoken);
    record.premium = BigDecimal.fromString("0");
    record.numberOfOTokens = BigDecimal.fromString("0");
  }
  record.premium = premiumPaid.plus(record.premium);
  record.numberOfOTokens = tokenAmount.plus(record.numberOfOTokens);
  record.save();

  oTokenIncrementPurchasesCount(event.params.otoken);
  createOrderBookEntry(
    event.params.buyer,
    event.params.otoken,
    premiumPaid,
    tokenAmount,
    event.block.timestamp
  );
}

/**
 * Called when a OptionsSold event is emitted. Modifies the locked amount of
   the pool, as well as updates the LPRecord and oToken entities.
 * @param {OptionsSold} event Descriptor of the event emitted.
 */
export function handleOptionsSold(event: OptionsSold): void {
  const poolId = createPoolId(event.params.lp, event.params.poolId);
  const pool = Pool.load(poolId);
  const tokenAmount = oTokenFixedtoDecimals(
    event.params.otoken,
    event.params.numberOfOtokens
  );
  const premiumAmount = collateralFixedtoDecimals(event.params.premiumReceived);
  const liquidityCollateralized = collateralFixedtoDecimals(
    event.params.liquidityCollateralized
  );
  pool.locked = liquidityCollateralized.plus(pool.locked);
  pool.size = premiumAmount.plus(pool.size);
  pool.unlocked = pool.size.minus(pool.locked);
  pool.utilization = pool.locked.div(pool.size);
  pool.save();

  setAndCalculatePNL(premiumAmount, Actions.PREMIUM_RECIEVED, pool as Pool);

  createPoolSnapshot(
    pool as Pool,
    event.block.timestamp,
    premiumAmount,
    Actions.PREMIUM_RECIEVED
  );

  const recordID = createLPRecordID(event.params.lp, event.params.otoken);
  let record = LPRecord.load(recordID);
  if (record == null) {
    record = new LPRecord(recordID);
    record.lp = event.params.lp;
    record.otoken = getOTokenIdFromAddress(event.params.otoken);
    record.numberOfOTokens = BigDecimal.fromString("0");
    record.liquidityCollateralized = BigDecimal.fromString("0");
    record.premiumReceived = BigDecimal.fromString("0");
  }
  record.premiumReceived = record.premiumReceived.plus(premiumAmount);
  record.liquidityCollateralized = record.liquidityCollateralized.plus(
    liquidityCollateralized
  );
  record.numberOfOTokens = record.numberOfOTokens.plus(tokenAmount);

  const poolRecordID = createPoolRecordID(
    event.params.lp,
    event.params.poolId,
    event.params.otoken
  );
  let poolRecord = PoolRecord.load(poolRecordID);

  if (poolRecord == null) {
    // The oToken (and record) has not recieved liquidity from this pool
    poolRecord = new PoolRecord(poolRecordID);
    poolRecord.pool = poolId;
    poolRecord.lpRecord = record.id;
    poolRecord.otoken = getOTokenIdFromAddress(event.params.otoken);
    poolRecord.collateral = liquidityCollateralized;
    poolRecord.premiumReceived = premiumAmount;
    poolRecord.numberOfOTokens = tokenAmount;
    poolRecord.save();
  } else {
    // Liquidity has been added from this pool, just change the poolRecord object.
    poolRecord.collateral = poolRecord.collateral.plus(liquidityCollateralized);
    poolRecord.premiumReceived = poolRecord.premiumReceived.plus(premiumAmount);
    poolRecord.numberOfOTokens = poolRecord.numberOfOTokens.plus(tokenAmount);
    poolRecord.save();
  }
  record.save();

  oTokenIncrementLiquidity(
    event.params.otoken,
    event.params.numberOfOtokens,
    event.params.liquidityCollateralized,
    event.params.premiumReceived
  );
}

/**
 * Called when a OptionSettlementDistributed event is emitted. Modifies the locked and size
   fields of the pool. This returns unclaimed collateral from the oToken to the pool.
 * @param {OptionSettlementDistributed} event Descriptor of the event emitted.
 */
export function handleOptionSettlementDistributed(
  event: OptionSettlementDistributed
): void {
  const recordID = createLPRecordID(event.params.lp, event.params.otoken);
  const record = LPRecord.load(recordID);

  const collateralReturned = collateralFixedtoDecimals(
    event.params.collateralReturned
  );
  record.liquidityCollateralized =
    record.liquidityCollateralized.minus(collateralReturned);

  record.save();

  const poolId = createPoolId(event.params.lp, event.params.poolId);
  const pool = Pool.load(poolId);

  const poolRecordID = createPoolRecordID(
    event.params.lp,
    event.params.poolId,
    event.params.otoken
  );
  const poolRecord = PoolRecord.load(poolRecordID);
  poolRecord.returned = collateralReturned;

  const poolTotalCollateralized: BigDecimal = poolRecord.collateral;
  const deltaCollateralizedAndReturned: BigDecimal =
    poolTotalCollateralized.minus(collateralReturned);

  pool.size = pool.size.minus(deltaCollateralizedAndReturned);
  pool.locked = pool.locked.minus(poolTotalCollateralized);
  pool.unlocked = pool.size.minus(pool.locked);
  pool.utilization = pool.locked.div(pool.size);
  pool.save();

  setAndCalculatePNL(
    deltaCollateralizedAndReturned,
    Actions.CAPITAL_EXERCISED,
    pool as Pool
  );

  createPoolSnapshot(
    pool as Pool,
    event.block.timestamp,
    deltaCollateralizedAndReturned,
    Actions.CAPITAL_EXERCISED
  );
}

/**
 * Called when a OptionSettled event is emitted. This happens when an
   oToken is settled.
 * @param {OptionSettled} event Descriptor of the event emitted.
 */
export function handleOptionsSettled(event: OptionSettled): void {
  oTokenSettled(event.params.otoken, event.params.collateralReturned);
}
