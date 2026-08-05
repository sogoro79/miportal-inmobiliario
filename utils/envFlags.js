export function envFlagEnabled(name, env = process.env) {
  return env?.[name] === "true";
}
