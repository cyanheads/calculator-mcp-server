/**
 * @fileoverview Types for the math service.
 * @module services/math/types
 */

/** Result of a math operation. */
export interface MathResult {
  /** Formatted string representation of the result. */
  result: string;
  /** math.js type name: number, BigNumber, Complex, Matrix, Unit, string, boolean. */
  resultType: string;
}
