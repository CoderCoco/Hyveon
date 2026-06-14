import { BadRequestException } from '@nestjs/common';

/**
 * Verify a body field is either missing or an array of strings. Returns the
 * validated array (empty if the field was omitted), or throws
 * `BadRequestException` which Nest maps to a 400 with the same shape the
 * legacy Express handlers used.
 */
export function requireStringArray(field: string, value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new BadRequestException({
      success: false,
      error: `${field} must be an array of strings`,
    });
  }
  return value as string[];
}
