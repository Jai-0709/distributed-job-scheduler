/**
 * Centralized error handling middleware.
 *
 * Maps known error types to consistent HTTP responses:
 * - Prisma P2002 (unique constraint) → 409 Conflict
 * - Prisma P2025 (record not found) → 404 Not Found
 * - Zod validation errors → 400 Bad Request
 * - Generic errors → 500 Internal Server Error
 *
 * All errors use the shape: { error: { code, message, details? } }
 */

import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { logger } from '../../shared/lib/logger';

export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
}

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

function isPrismaError(err: unknown): err is { code: string; meta?: { target?: string[] } } {
  return (
    err instanceof Error &&
    (err.constructor.name === 'PrismaClientKnownRequestError' ||
      err.constructor.name === 'PrismaClientValidationError') &&
    'code' in err
  );
}

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  // Zod validation error
  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        details: err.errors,
      },
    });
    return;
  }

  // Application-level error
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      error: {
        code: err.code,
        message: err.message,
        details: err.details,
      },
    });
    return;
  }

  // Prisma errors — check by constructor name since the generated client
  // may not export PrismaClientKnownRequestError from the top level before
  // `prisma generate` has been run.
  if (isPrismaError(err)) {
    const prismaErr = err as { code: string; meta?: { target?: string[] } };

    if (prismaErr.code === 'P2002') {
      res.status(409).json({
        error: {
          code: 'CONFLICT',
          message: 'A record with these values already exists',
          details: { fields: prismaErr.meta?.target },
        },
      });
      return;
    }

    if (prismaErr.code === 'P2025') {
      res.status(404).json({
        error: {
          code: 'NOT_FOUND',
          message: 'Record not found',
        },
      });
      return;
    }

    if (prismaErr.code === 'P2003') {
      res.status(409).json({
        error: {
          code: 'FOREIGN_KEY_CONSTRAINT',
          message: 'Cannot complete operation due to a related record constraint',
        },
      });
      return;
    }
  }

  // Unknown error
  logger.error('Unhandled API error', {
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
    path: req.path,
    method: req.method,
  });

  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
    },
  });
}
