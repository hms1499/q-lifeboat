import { describe, expect, it } from "vitest";
import { checkWithdraw } from "./vaultForm";

const owner = "0x337a4e2118c11cfc858831f7388ec0c8d9a156b6" as const;
const vault = "0x8f3e1b9fe35fa900150327bc06fa6cd2b503e2e2" as const;
const E18 = 10n ** 18n;
const base = { amount: "10", balance: 40n * E18, to: "0xaa32a8256007015eb636b19e105abde94c51ef00", owner, vault };

describe("checkWithdraw", () => {
  it("accepts a decimal amount within the vault balance to a fresh address", () => {
    expect(checkWithdraw(base)).toEqual({});
    expect(checkWithdraw({ ...base, amount: "40" })).toEqual({});
    expect(checkWithdraw({ ...base, amount: "0.5" })).toEqual({});
  });

  it("refuses empty, zero, non-decimal and too-large amounts", () => {
    expect(checkWithdraw({ ...base, amount: "" }).amount).toBe("Enter an amount.");
    expect(checkWithdraw({ ...base, amount: "0" }).amount).toBe("The amount must be above zero.");
    expect(checkWithdraw({ ...base, amount: "abc" }).amount).toBe("Not a number.");
    expect(checkWithdraw({ ...base, amount: "40.01" }).amount).toBe("Your vault holds 40.");
    expect(checkWithdraw({ ...base, balance: undefined }).amount).toBe("Reading your vault balance…");
  });

  it("refuses a bad address, the zero address, the leaked account (any case) and the vault itself", () => {
    expect(checkWithdraw({ ...base, to: "" }).to).toBe("Enter the address to send to.");
    expect(checkWithdraw({ ...base, to: "0x123" }).to).toBe("That is not a 0x address.");
    expect(checkWithdraw({ ...base, to: "0x0000000000000000000000000000000000000000" }).to).toBe("That is the zero address: tokens sent there are lost.");
    expect(checkWithdraw({ ...base, to: owner.toUpperCase().replace("0X", "0x") }).to).toBe("This is the account whose key may have leaked. Choose a fresh address.");
    expect(checkWithdraw({ ...base, to: vault }).to).toBe("That is your vault itself.");
  });
});
