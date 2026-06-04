/**
 * @fileoverview Types for the math service.
 * @module services/math/types
 */

/** Numeric type for evaluate operations. */
export type NumericType = 'number' | 'BigNumber' | 'Fraction';

/** Result of a math operation. */
export interface MathResult {
  /** Formatted string representation of the result. */
  result: string;
  /** math.js type name: number, BigNumber, Fraction, Complex, Matrix, Unit, string, boolean. */
  resultType: string;
  /**
   * Whether the simplify operation returned the expression unchanged.
   * Present only for `simplify` operations. `true` means the simplifier
   * could not reduce the expression further; `false` means it made progress.
   */
  unchanged?: boolean;
}
