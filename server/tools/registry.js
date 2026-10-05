// Wraps a list of tools ({ def, label, confirm, run }) with lookup, approval policy and execution.
export function makeRegistry(list) {
  const byName = new Map(list.map((t) => [t.def.function.name, t]));
  return {
    definitions: list.map((t) => t.def),

    // Describes what a call will do and whether the user must approve it first. null = unknown tool.
    policy(name, args) {
      const t = byName.get(name);
      if (!t) return null;
      try {
        return { label: t.label(args), summary: t.confirm(args) };
      } catch (err) {
        return { label: "Using a tool", summary: null, error: err.message };
      }
    },

    call: (name, args) => byName.get(name).run(args ?? {}),
  };
}
