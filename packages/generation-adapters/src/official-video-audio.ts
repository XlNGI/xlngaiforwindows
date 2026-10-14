import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import type { ValidateFunction } from 'ajv';
import {
  officialVideoAudioContracts,
  type AdapterValidationResult,
  type ModelContract,
} from '@ai-video/contracts';

// Canonical request previews do not enable channels or make network calls.
const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  strictTypes: false,
  strictRequired: false,
});
(addFormatsModule as unknown as (instance: Ajv2020) => Ajv2020)(ajv);
const validators = new Map<string, ValidateFunction>();

export function getOfficialVideoAudioContract(
  contractId: string,
  contractRevision = 1,
): ModelContract | undefined {
  const contract = officialVideoAudioContracts.find(
    (item) => item.contractId === contractId && item.contractRevision === contractRevision,
  );
  return contract ? structuredClone(contract) : undefined;
}

export function validateOfficialVideoAudioParameters(
  contractId: string,
  parameters: unknown,
  contractRevision = 1,
): AdapterValidationResult {
  const contract = getOfficialVideoAudioContract(contractId, contractRevision);
  if (!contract) return { valid: false, errors: [{ path: '', message: '官方合同修订不存在。' }] };
  const key = `${contractId}:${contractRevision}`;
  let validator = validators.get(key);
  if (!validator) {
    validator = ajv.compile(contract.parameterSchema);
    validators.set(key, validator);
  }
  return {
    valid: Boolean(validator(parameters)),
    errors: (validator.errors ?? []).map((error) => ({
      path: error.instancePath || String(error.params.missingProperty ?? ''),
      message: error.message ?? '官方参数无效。',
    })),
  };
}

/** Preserve official nesting; unknown values are rejected before projection. */
export function buildOfficialVideoAudioRequest(
  contractId: string,
  parameters: unknown,
  contractRevision = 1,
): Record<string, unknown> {
  const contract = getOfficialVideoAudioContract(contractId, contractRevision);
  const validation = validateOfficialVideoAudioParameters(contractId, parameters, contractRevision);
  if (!contract || !validation.valid) {
    throw new Error(
      `官方合同参数无效：${validation.errors.map((error) => `${error.path} ${error.message}`).join('; ')}`,
    );
  }
  const input = parameters as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  // Kling's model-specific endpoint identifies the model in the URL.
  if (contract.providerFamily !== 'kling' && contract.capabilities.videoGeneration)
    output.model = contract.officialModelName;
  for (const mapping of contract.transport.request) {
    if (mapping.operation !== 'copy' || !mapping.from) throw new Error('官方请求映射未实现。');
    if (!Object.hasOwn(input, mapping.from)) continue;
    const path = mapping.to.split('.');
    if (path.some((part) => !part || ['__proto__', 'prototype', 'constructor'].includes(part)))
      throw new Error('官方请求映射路径无效。');
    let target = output;
    for (const part of path.slice(0, -1)) {
      target[part] ??= {};
      target = target[part] as Record<string, unknown>;
    }
    target[path.at(-1)!] = structuredClone(input[mapping.from]);
  }
  return output;
}
