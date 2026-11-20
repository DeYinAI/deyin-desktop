import type { SecureFormRequest } from "@deyin/host-core/shared";

/** What has been typed into each field of a Secure Form, by field id. */
export type SecureFormValues = Record<string, string>;

export function emptySecureFormValues(request: SecureFormRequest): SecureFormValues {
  return Object.fromEntries(request.fields.map((field) => [field.id, ""]));
}

/**
 * What to send back: only the fields something was typed into, exactly as typed (a space in a password is part of
 * it). Null when nothing was typed, which is not an answer.
 */
export function secureFormAnswer(request: SecureFormRequest, values: SecureFormValues): SecureFormValues | null {
  const answer: SecureFormValues = {};
  for (const field of request.fields) {
    const value = values[field.id];
    if (value !== undefined && value !== "") answer[field.id] = value;
  }
  return Object.keys(answer).length === 0 ? null : answer;
}

export function canSubmitSecureForm(request: SecureFormRequest, values: SecureFormValues): boolean {
  return secureFormAnswer(request, values) !== null;
}
