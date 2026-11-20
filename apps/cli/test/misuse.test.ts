import { decodeFunctionData, erc20Abi, toFunctionSelector } from "viem";
import { describe, expect, it } from "vitest";
import { misuseCall, misuseExitCode } from "../src/misuse";

const TOKEN = "0x1111111111111111111111111111111111111111" as const;
const TO = "0x9999999999999999999999999999999999999999" as const;

describe("misuseCall", () => {
  it("calls token.transfer(to, amount) directly, not through the vault", () => {
    const c = misuseCall(TOKEN, TO, 5n);
    expect(c.to).toBe(TOKEN);
    expect(c.value).toBe("0");
    expect(c.gasLimit).toBe(200_000n);
    expect(c.data.slice(0, 10)).toBe(toFunctionSelector("transfer(address,uint256)"));
    const d = decodeFunctionData({ abi: erc20Abi, data: c.data });
    expect(d.functionName).toBe("transfer");
    expect((d.args as unknown as [string, bigint])[1]).toBe(5n);
    expect((d.args as unknown as [string, bigint])[0].toLowerCase()).toBe(TO);
  });
});

describe("misuseExitCode", () => {
  it("0 only when the chain refused by call policy", () => {
    expect(misuseExitCode([{ success: false, error: "authenticator not permitted for this action" }])).toBe(0);
    expect(misuseExitCode([{ success: false, error: "The call is Not Permitted by the rule" }])).toBe(0);
  });
  it("1 (inconclusive) for a revert or a spending-limit refusal: not proof the policy blocked it", () => {
    expect(misuseExitCode([{ success: false, error: "execution reverted" }])).toBe(1);
    expect(misuseExitCode([{ success: false, error: "amount exceeds per-tx limit 1000000000000000000000" }])).toBe(1);
    expect(misuseExitCode([{ success: false }])).toBe(1);
  });
  it("2 when the agent key moved tokens", () => {
    expect(misuseExitCode([{ success: true }])).toBe(2);
  });
  it("1 when nothing was decoded", () => {
    expect(misuseExitCode([])).toBe(1);
  });
});
