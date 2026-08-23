export function buildTools() {
  return [
    {
      name: "greet",
      execute: async (input) => ({
        status: "ok",
        output: `hello ${input?.who ?? "world"}`,
      }),
    },
  ];
}
