// @flow
import invariant from "invariant";
import { Buffer } from "buffer";
import { BigNumber } from "bignumber.js";
import { log } from "@ledgerhq/logs";
import type {
  Transaction,
  TransactionRaw,
  EthereumGasLimitRequest,
} from "./types";
import { Transaction as EthereumTx } from "ethereumjs-tx";
import {
  fromTransactionCommonRaw,
  toTransactionCommonRaw,
} from "../../transaction/common";
import type { Account, CryptoCurrency } from "../../types";
import { getAccountUnit } from "../../account";
import { formatCurrencyUnit } from "../../currencies";
import { apiForCurrency } from "../../api/Ethereum";
import { makeLRUCache } from "../../cache";
import { getEnv } from "../../env";
import { modes } from "./modules";

export const formatTransaction = (
  t: Transaction,
  mainAccount: Account
): string => {
  const gasLimit = getGasLimit(t);
  const account =
    (t.subAccountId &&
      (mainAccount.subAccounts || []).find((a) => a.id === t.subAccountId)) ||
    mainAccount;
  return `
${t.mode.toUpperCase()} ${
    t.useAllAmount
      ? "MAX"
      : formatCurrencyUnit(getAccountUnit(account), t.amount, {
          showCode: true,
          disableRounding: true,
        })
  }
TO ${t.recipient}
with gasPrice=${formatCurrencyUnit(
    mainAccount.currency.units[1],
    t.gasPrice || BigNumber(0)
  )}
with gasLimit=${gasLimit.toString()}`;
};

const defaultGasLimit = BigNumber(0x5208);

export const getGasLimit = (t: Transaction): BigNumber =>
  t.userGasLimit || t.estimatedGasLimit || defaultGasLimit;

export const fromTransactionRaw = (tr: TransactionRaw): Transaction => {
  const common = fromTransactionCommonRaw(tr);
  const { networkInfo } = tr;
  return {
    ...common,
    mode: tr.mode,
    nonce: tr.nonce,
    data: tr.data ? Buffer.from(tr.data, "hex") : undefined,
    family: tr.family,
    gasPrice: tr.gasPrice ? BigNumber(tr.gasPrice) : null,
    userGasLimit: tr.userGasLimit ? BigNumber(tr.userGasLimit) : null,
    estimatedGasLimit: tr.estimatedGasLimit
      ? BigNumber(tr.estimatedGasLimit)
      : null,
    feeCustomUnit: tr.feeCustomUnit, // FIXME this is not good.. we're dereferencing here. we should instead store an index (to lookup in currency.units on UI)
    networkInfo: networkInfo && {
      family: networkInfo.family,
      gasPrice: BigNumber(networkInfo.gasPrice),
    },
  };
};

export const toTransactionRaw = (t: Transaction): TransactionRaw => {
  const common = toTransactionCommonRaw(t);
  const { networkInfo } = t;
  return {
    ...common,
    mode: t.mode,
    nonce: t.nonce,
    family: t.family,
    data: t.data ? t.data.toString("hex") : undefined,
    gasPrice: t.gasPrice ? t.gasPrice.toString() : null,
    userGasLimit: t.userGasLimit ? t.userGasLimit.toString() : null,
    estimatedGasLimit: t.estimatedGasLimit
      ? t.estimatedGasLimit.toString()
      : null,
    feeCustomUnit: t.feeCustomUnit, // FIXME drop?
    networkInfo: networkInfo && {
      family: networkInfo.family,
      gasPrice: networkInfo.gasPrice.toString(),
    },
  };
};

// see https://github.com/ethereum/EIPs/blob/master/EIPS/eip-155.md
export function getNetworkId(currency: CryptoCurrency): ?number {
  switch (currency.id) {
    case "ethereum":
      return 1;
    case "ethereum_classic":
      return 61;
    case "ethereum_classic_ropsten":
      return 62;
    case "ethereum_ropsten":
      return 3;
    default:
      return null;
  }
}

export function inferTokenAccount(a: Account, t: Transaction) {
  const tokenAccount = !t.subAccountId
    ? null
    : a.subAccounts && a.subAccounts.find((ta) => ta.id === t.subAccountId);
  if (tokenAccount && tokenAccount.type === "TokenAccount") {
    return tokenAccount;
  }
}

export function buildEthereumTx(
  account: Account,
  transaction: Transaction,
  nonce: number
) {
  const { currency } = account;
  const { gasPrice } = transaction;
  const subAccount = inferTokenAccount(account, transaction);

  invariant(
    !subAccount || subAccount.type === "TokenAccount",
    "only token accounts expected"
  );

  const chainId = getNetworkId(currency);
  invariant(chainId, `chainId not found for currency ${currency.name}`);

  const gasLimit = getGasLimit(transaction);

  const ethTxObject: Object = {
    nonce,
    chainId,
    gasPrice: `0x${BigNumber(gasPrice || 0).toString(16)}`,
    gasLimit: `0x${BigNumber(gasLimit).toString(16)}`,
  };

  const m = modes[transaction.mode];
  invariant(m, "missing module for mode=" + transaction.mode);
  m.fillTransactionData(account, transaction, ethTxObject);

  const tx = new EthereumTx(ethTxObject);
  // these will be filled by device signature
  tx.raw[6] = Buffer.from([chainId]); // v
  tx.raw[7] = Buffer.from([]); // r
  tx.raw[8] = Buffer.from([]); // s

  return tx;
}

export function inferEthereumGasLimitRequest(
  account: Account,
  transaction: Transaction
): EthereumGasLimitRequest {
  const r: EthereumGasLimitRequest = {
    from: account.freshAddress,
    amplifier: "1",
  };
  if (transaction.gasPrice) {
    r.gasPrice = "0x" + transaction.gasPrice.toString();
  }
  try {
    const { data, to, value } = buildEthereumTx(account, transaction, 1);
    if (value) {
      r.value = "0x" + value.toString();
    }
    if (to) {
      r.to = "0x" + to.toString("hex");
    }
    if (data) {
      r.data = "0x" + data.toString("hex");
    }
  } catch (e) {
    log("warn", "couldn't serializeTransactionData: " + e);
  }

  return r;
}

export const estimateGasLimit: (
  account: Account,
  addr: string,
  request: EthereumGasLimitRequest
) => Promise<BigNumber> = makeLRUCache(
  (account: Account, addr: string, request: EthereumGasLimitRequest) => {
    const api = apiForCurrency(account.currency);
    return api
      .getDryRunGasLimit(addr, request)
      .then((value) =>
        value.eq(21000) // regular ETH send should not be amplified
          ? value
          : value.times(getEnv("ETHEREUM_GAS_LIMIT_AMPLIFIER"))
      )
      .catch(() => api.roughlyEstimateGasLimit(addr));
  },
  (a, addr, r) =>
    a.id +
    "|" +
    addr +
    "|" +
    String(r.from) +
    "+" +
    String(r.to) +
    "+" +
    String(r.value) +
    "+" +
    String(r.data) +
    "+" +
    String(r.gasPrice) +
    "+" +
    String(r.amplifier)
);

export default {
  formatTransaction,
  fromTransactionRaw,
  toTransactionRaw,
};
