import { emitModel } from '@substrat-run/contracts';
import { salesEntities } from './entities.js';
import { salesOperations } from './operations.js';

/** The artifact of record, emitted from the declaration. */
export const salesModel = emitModel(salesEntities, { operations: salesOperations });
