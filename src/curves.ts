import { Bytes } from "@graphprotocol/graph-ts";
import { CurveAdded } from "../generated/CurveManager/CurveManager";
import { Curve } from "../generated/schema";
import { int59x18ToDecimal } from "./helpers";

export function createCriteriaId(criteriaHash: Bytes): string {
  return criteriaHash.toHexString();
}

export function createCriteriaSetId(criteriaSetHash: Bytes): string {
  return criteriaSetHash.toHexString();
}

export function createCriteriaJoinedCriteriaSetId(
  criteriaHash: Bytes,
  criteriaSetHash: Bytes
): string {
  return criteriaHash.toHexString() + criteriaSetHash.toHexString();
}

/**
 * Called when a CurveAdded event is emitted. Creates a new Curve entity.
 * @param {CurveAdded} event Descriptor of the event emitted.
 */
export function handleCurveAdded(event: CurveAdded): void {
  const curveId: Bytes = event.params.curveHash;
  let curve = Curve.load(curveId.toHexString());
  if (curve == null) {
    curve = new Curve(curveId.toHexString());
  }

  curve.a = int59x18ToDecimal(event.params.curveParams.a_59x18);
  curve.b = int59x18ToDecimal(event.params.curveParams.b_59x18);
  curve.c = int59x18ToDecimal(event.params.curveParams.c_59x18);
  curve.d = int59x18ToDecimal(event.params.curveParams.d_59x18);
  curve.maxUtil = int59x18ToDecimal(event.params.curveParams.max_util_59x18);

  curve.save();
}
