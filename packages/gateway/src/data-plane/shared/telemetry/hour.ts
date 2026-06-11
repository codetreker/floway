export const currentHour = (): string => new Date().toISOString().slice(0, 13);
