import { BigNumber } from "bignumber.js";
import { Observable } from "rxjs";
import { TypeRegistry } from "@polkadot/types";
import { u8aConcat } from "@polkadot/util";
import { FeeNotLoaded } from "@ledgerhq/errors";
import Polkadot from "@ledgerhq/hw-app-polkadot";
import type { Transaction } from "./types";
import type { Account, Operation, SignOperationEvent } from "../../types";
import { open, close } from "../../hw";
import { encodeOperationId } from "../../operation";
import { buildTransaction } from "./js-buildTransaction";
import { calculateAmount, getNonce, isFirstBond } from "./logic";
const MODE_TO_TYPE = {
  send: "OUT",
  bond: "BOND",
  unbond: "UNBOND",
  rebond: "BOND",
  withdrawUnbonded: "WITHDRAW_UNBONDED",
  nominate: "NOMINATE",
  chill: "CHILL",
  claimReward: "REWARD_PAYOUT",
  default: "FEES",
};
const MODE_TO_PALLET_METHOD = {
  send: "balances.transferKeepAlive",
  bond: "staking.bond",
  bondExtra: "staking.bondExtra",
  unbond: "staking.unbond",
  rebond: "staking.rebond",
  withdrawUnbonded: "staking.withdrawUnbonded",
  nominate: "staking.nominate",
  chill: "staking.chill",
  claimReward: "staking.payoutStakers",
};

const getExtra = (type: string, account: Account, transaction: Transaction) => {
  const extra = MODE_TO_PALLET_METHOD[transaction.mode]
    ? {
        palletMethod:
          MODE_TO_PALLET_METHOD[
            transaction.mode === "bond" && !isFirstBond(account)
              ? "bondExtra"
              : transaction.mode
          ],
      }
    : {};

  switch (type) {
    case "OUT":
      return { ...extra, transferAmount: new BigNumber(transaction.amount) };

    case "BOND":
      return { ...extra, bondedAmount: new BigNumber(transaction.amount) };

    case "UNBOND":
      return { ...extra, unbondedAmount: new BigNumber(transaction.amount) };

    case "WITHDRAW_UNBONDED":
      return {
        ...extra,
        withdrawUnbondedAmount: new BigNumber(
          account.polkadotResources?.unlockedBalance || 0
        ),
      };

    case "NOMINATE":
      return { ...extra, validators: transaction.validators };
  }

  return extra;
};

const buildOptimisticOperation = (
  account: Account,
  transaction: Transaction,
  fee: BigNumber
): Operation => {
  const type = MODE_TO_TYPE[transaction.mode] ?? MODE_TO_TYPE.default;
  const value =
    type === "OUT"
      ? new BigNumber(transaction.amount).plus(fee)
      : new BigNumber(fee);
  const extra = getExtra(type, account, transaction);
  const operation: Operation = {
    id: encodeOperationId(account.id, "", type),
    hash: "",
    type,
    value,
    fee,
    blockHash: null,
    blockHeight: null,
    senders: [account.freshAddress],
    recipients: [transaction.recipient].filter(Boolean),
    accountId: account.id,
    transactionSequenceNumber: getNonce(account),
    date: new Date(),
    extra,
  };
  return operation;
};

/**
 * Serialize a signed transaction in a format that can be submitted over the
 * Node RPC Interface from the signing payload and signature produced by the
 * remote signer.
 *
 * @param unsigned - The JSON representing the unsigned transaction.
 * @param signature - Signature of the signing payload produced by the remote signer.
 * @param registry - Registry used for constructing the payload.
 */
export const signExtrinsic = async (
  unsigned: Record<string, any>,
  signature: any,
  registry: TypeRegistry
): Promise<string> => {
  const extrinsic = registry.createType("Extrinsic", unsigned, {
    version: unsigned.version,
  });
  extrinsic.addSignature(unsigned.address, signature, unsigned as any);
  return extrinsic.toHex();
};

/**
 * Sign Extrinsic with a fake signature (for fees estimation).
 *
 * @param unsigned - The JSON representing the unsigned transaction.
 * @param registry - Registry used for constructing the payload.
 */
export const fakeSignExtrinsic = async (
  unsigned: Record<string, any>,
  registry: TypeRegistry
): Promise<string> => {
  const fakeSignature = u8aConcat(
    new Uint8Array([1]),
    new Uint8Array(64).fill(0x42)
  );
  return signExtrinsic(unsigned, fakeSignature, registry);
};

/**
 * Sign Transaction with Ledger hardware
 */
const signOperation = ({
  account,
  deviceId,
  transaction,
}: {
  account: Account;
  deviceId: any;
  transaction: Transaction;
}): Observable<SignOperationEvent> =>
  new Observable((o) => {
    async function main() {
      const transport = await open(deviceId);

      try {
        o.next({
          type: "device-signature-requested",
        });

        if (!transaction.fees) {
          throw new FeeNotLoaded();
        }

        // Ensure amount is filled when useAllAmount
        const transactionToSign = {
          ...transaction,
          amount: calculateAmount({
            a: account,
            t: transaction,
          }),
        };
        const { unsigned, registry } = await buildTransaction(
          account,
          transactionToSign,
          true
        );
        const payload = registry
          .createType("ExtrinsicPayload", unsigned, {
            version: unsigned.version,
          })
          .toU8a({
            method: true,
          });
        // Sign by device
        const polkadot = new Polkadot(transport);
        // FIXME: the type of payload Uint8Array is not compatible with the signature of sign which accept a string
        const r = await polkadot.sign(account.freshAddressPath, payload as any);
        const signed = await signExtrinsic(unsigned, r.signature, registry);
        o.next({
          type: "device-signature-granted",
        });
        const operation = buildOptimisticOperation(
          account,
          transactionToSign,
          transactionToSign.fees ?? new BigNumber(0)
        );
        o.next({
          type: "signed",
          signedOperation: {
            operation,
            signature: signed,
            expirationDate: null,
          },
        });
      } finally {
        close(transport, deviceId);
      }
    }

    main().then(
      () => o.complete(),
      (e) => o.error(e)
    );
  });

export default signOperation;
