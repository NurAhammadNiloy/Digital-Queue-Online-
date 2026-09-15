/** The same canonical form is used for login, provisioning and conflicts. */
export const normalizeStaffCode = (value: string) => value.trim().toUpperCase();
export const isValidStaffCode = (value: string) => /^[A-Z0-9][A-Z0-9_-]{2,31}$/.test(value);
