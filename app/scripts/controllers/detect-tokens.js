import Web3 from 'web3';
import contracts from '@metamask/contract-metadata';
import { warn } from 'loglevel';
import SINGLE_CALL_BALANCES_ABI from 'single-call-balance-checker-abi';
import { MAINNET_CHAIN_ID } from '../../../shared/constants/network';
import { SINGLE_CALL_BALANCES_ADDRESS } from '../constants/contracts';
import { MINUTE } from '../../../shared/constants/time';
import { isEqualCaseInsensitive } from '../../../ui/helpers/utils/util';

// By default, poll every 3 minutes
const DEFAULT_INTERVAL = MINUTE * 3;

/**
 * A controller that polls for token exchange
 * rates based on a user's current token list
 */
export default class DetectTokensController {
  /**
   * Creates a DetectTokensController
   *
   * @param {Object} [config] - Options to configure controller
   */
  constructor({
    interval = DEFAULT_INTERVAL,
    preferences,
    network,
    keyringMemStore,
    tokensController,
  } = {}) {
    this.tokensController = tokensController;
    this.preferences = preferences;
    this.interval = interval;
    this.network = network;
    this.keyringMemStore = keyringMemStore;
    this.selectedAddress = this.preferences?.store.getState().selectedAddress;
    this.tokenAddresses = this.tokensController?.state.tokens.map((token) => {
      return token.address;
    });
    this.hiddenTokens = this.tokensController?.state.ignoredTokens;

    preferences?.store.subscribe(({ selectedAddress }) => {
      if (this.selectedAddress !== selectedAddress) {
        this.selectedAddress = selectedAddress;
        this.restartTokenDetection();
      }
    });
    tokensController?.subscribe(({ tokens = [], ignoredTokens = [] }) => {
      this.tokenAddresses = tokens.map((token) => {
        return token.address;
      });
      this.hiddenTokens = ignoredTokens;
    });
  }

  /**
   * For each token in @metamask/contract-metadata, find check selectedAddress balance.
   */
  async detectNewTokens() {
    if (!this.isActive) {
      return;
    }
    if (this._network.store.getState().provider.chainId !== MAINNET_CHAIN_ID) {
      return;
    }

    const tokensToDetect = [];
    this.web3.setProvider(this._network._provider);
    for (const contractAddress in contracts) {
      if (
        contracts[contractAddress].erc20 &&
        !this.tokenAddresses.find((tokenAddress) =>
          isEqualCaseInsensitive(tokenAddress, contractAddress),
        ) &&
        !this.hiddenTokens.find((token) =>
          isEqualCaseInsensitive(token.address, contractAddress),
        )
      ) {
        tokensToDetect.push(contractAddress);
      }
    }

    let result;
    try {
      result = await this._getTokenBalances(tokensToDetect);
    } catch (error) {
      warn(
        `MetaMask - DetectTokensController single call balance fetch failed`,
        error,
      );
      return;
    }

    await Promise.all(
      tokensToDetect.map(async (tokenAddress, index) => {
        const balance = result[index];
        let ignored;
        if (this.hiddenTokens.length) {
          ignored = this.hiddenTokens.find((ignoredTokenAddress) =>
            isEqualCaseInsensitive(ignoredTokenAddress, tokenAddress),
          );
        }
        if (balance && !balance.isZero() && ignored === undefined) {
          await this.tokensController.addToken(
            tokenAddress,
            contracts[tokenAddress].symbol,
            contracts[tokenAddress].decimals,
          );
        }
      }),
    );
  }

  async _getTokenBalances(tokens) {
    const ethContract = this.web3.eth
      .contract(SINGLE_CALL_BALANCES_ABI)
      .at(SINGLE_CALL_BALANCES_ADDRESS);
    return new Promise((resolve, reject) => {
      ethContract.balances([this.selectedAddress], tokens, (error, result) => {
        if (error) {
          return reject(error);
        }
        return resolve(result);
      });
    });
  }

  /**
   * Restart token detection polling period and call detectNewTokens
   * in case of address change or user session initialization.
   *
   */
  restartTokenDetection() {
    if (!(this.isActive && this.selectedAddress)) {
      return;
    }
    this.detectNewTokens();
    this.interval = DEFAULT_INTERVAL;
  }

  /* eslint-disable accessor-pairs */
  /**
   * @type {Number}
   */
  set interval(interval) {
    this._handle && clearInterval(this._handle);
    if (!interval) {
      return;
    }
    this._handle = setInterval(() => {
      this.detectNewTokens();
    }, interval);
  }

  /**
   * @type {Object}
   */
  set network(network) {
    if (!network) {
      return;
    }
    this._network = network;
    this.web3 = new Web3(network._provider);
  }

  /**
   * In setter when isUnlocked is updated to true, detectNewTokens and restart polling
   * @type {Object}
   */
  set keyringMemStore(keyringMemStore) {
    if (!keyringMemStore) {
      return;
    }
    this._keyringMemStore = keyringMemStore;
    this._keyringMemStore.subscribe(({ isUnlocked }) => {
      if (this.isUnlocked !== isUnlocked) {
        this.isUnlocked = isUnlocked;
        if (isUnlocked) {
          this.restartTokenDetection();
        }
      }
    });
  }

  /**
   * Internal isActive state
   * @type {Object}
   */
  get isActive() {
    return this.isOpen && this.isUnlocked;
  }
  /* eslint-enable accessor-pairs */
}
