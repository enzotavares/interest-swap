import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers, network } from "hardhat";

import { Pair, ERC20, Factory, ERC20Small, ERC20RMint } from "../typechain";

import {
  multiDeploy,
  sortTokens,
  getECSign,
  getPairDigest,
  getPairDomainSeparator,
  PRIVATE_KEYS,
  advanceBlockAndTime,
  deploy,
  sqrt,
  min,
} from "./utils";

const { parseEther } = ethers.utils;

const PERIOD_SIZE = 86400 / 12;

const MINIMUM_LIQUIDITY = ethers.BigNumber.from(1000);

describe("Pair", () => {
  let volatilePair: Pair;
  let factory: Factory;
  let tokenA: ERC20;
  let tokenB: ERC20;
  let tokenC: ERC20Small;

  let owner: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let treasury: SignerWithAddress;

  beforeEach(async () => {
    [[owner, alice, bob, treasury], [factory, tokenA, tokenB, tokenC]] =
      await Promise.all([
        ethers.getSigners(),
        multiDeploy(
          ["Factory", "ERC20", "ERC20", "ERC20Small"],
          [[], ["TokenA", "TA"], ["TokenB", "TB"], ["Small Token", "ST"]]
        ),
      ]);

    await factory.createPair(tokenA.address, tokenB.address, false);
    const volatilePairAddress = await factory.getPair(
      tokenA.address,
      tokenB.address,
      false
    );

    volatilePair = (await ethers.getContractFactory("Pair")).attach(
      volatilePairAddress
    );

    await Promise.all([
      tokenA.mint(alice.address, parseEther("10000")),
      tokenA.mint(bob.address, parseEther("10000")),
      tokenB.mint(alice.address, parseEther("5000")),
      tokenB.mint(bob.address, parseEther("5000")),
    ]);
  });

  it("sets the initial data correctly", async () => {
    await factory.createPair(tokenA.address, tokenC.address, true);
    const stablePairAddress = await factory.getPair(
      tokenA.address,
      tokenC.address,
      true
    );

    const stablePair = (await ethers.getContractFactory("Pair")).attach(
      stablePairAddress
    );

    const [token0Address] = sortTokens(tokenA.address, tokenC.address);

    const token0 = token0Address === tokenA.address ? tokenA : tokenC;
    const token1 = token0Address === tokenA.address ? tokenC : tokenA;

    const [
      sMetadata,
      vMetadata,
      observationLength,
      token0Decimals,
      token1Decimals,
      vFeesContract,
      sFeesContract,
    ] = await Promise.all([
      stablePair.metadata(),
      volatilePair.metadata(),
      stablePair.observationLength(),
      token0.decimals(),
      token1.decimals(),
      volatilePair.feesContract(),
      stablePair.feesContract(),
    ]);

    expect(observationLength).to.be.equal(12);
    expect(sMetadata[0]).to.be.equal(token0.address);
    expect(sMetadata[1]).to.be.equal(token1.address);
    expect(sMetadata[2]).to.be.equal(true);
    expect(vMetadata[2]).to.be.equal(false);
    expect(sMetadata[3]).to.be.equal(parseEther("0.0005"));
    expect(vMetadata[3]).to.be.equal(parseEther("0.003"));
    expect(sMetadata[6]).to.be.equal(
      ethers.BigNumber.from(10).pow(token0Decimals)
    );
    expect(sMetadata[7]).to.be.equal(
      ethers.BigNumber.from(10).pow(token1Decimals)
    );
    expect(vFeesContract > ethers.constants.AddressZero).to.be.equal(true);
    expect(sFeesContract > ethers.constants.AddressZero).to.be.equal(true);
  });

  describe("ERC20 functionality", () => {
    it("has all ERC20 metadata", async () => {
      await factory.createPair(tokenA.address, tokenB.address, true);
      const stablePairAddress = await factory.getPair(
        tokenA.address,
        tokenB.address,
        true
      );

      const stablePair = (await ethers.getContractFactory("Pair")).attach(
        stablePairAddress
      );

      const [token0Address] = sortTokens(tokenA.address, tokenB.address);

      const token0 = token0Address === tokenA.address ? tokenA : tokenB;
      const token1 = token0Address === tokenA.address ? tokenB : tokenA;

      const [
        decimals,
        vSymbol,
        vName,
        sName,
        sSymbol,
        token0Symbol,
        token1Symbol,
      ] = await Promise.all([
        volatilePair.decimals(),
        volatilePair.symbol(),
        volatilePair.name(),
        stablePair.name(),
        stablePair.symbol(),
        token0.symbol(),
        token1.symbol(),
      ]);

      expect(decimals).to.be.equal(18);
      expect(vSymbol).to.be.equal(`vILP-${token0Symbol}/${token1Symbol}`);
      expect(vName).to.be.equal(
        `Int Volatile LP - ${token0Symbol}/${token1Symbol}`
      );
      expect(sSymbol).to.be.equal(`sILP-${token0Symbol}/${token1Symbol}`);
      expect(sName).to.be.equal(
        `Int Stable LP - ${token0Symbol}/${token1Symbol}`
      );
    });

    it("allows users to give allowance to others", async () => {
      expect(
        await volatilePair.allowance(alice.address, bob.address)
      ).to.be.equal(0);

      await expect(volatilePair.connect(alice).approve(bob.address, 1000))
        .to.emit(volatilePair, "Approval")
        .withArgs(alice.address, bob.address, 1000);

      expect(
        await volatilePair.allowance(alice.address, bob.address)
      ).to.be.equal(1000);
    });

    it("allows users to transfer tokens", async () => {
      await Promise.all([
        tokenA.connect(alice).transfer(volatilePair.address, parseEther("100")),
        tokenB.connect(alice).transfer(volatilePair.address, parseEther("50")),
      ]);

      await volatilePair.mint(alice.address);

      const [aliceBalance, bobBalance, totalSupply] = await Promise.all([
        volatilePair.balanceOf(alice.address),
        volatilePair.balanceOf(bob.address),
        volatilePair.totalSupply(),
      ]);

      expect(bobBalance).to.be.equal(0);
      // minimum balance
      expect(totalSupply).to.be.equal(aliceBalance.add(1000));

      await expect(
        volatilePair.connect(alice).transfer(bob.address, parseEther("10"))
      )
        .to.emit(volatilePair, "Transfer")
        .withArgs(alice.address, bob.address, parseEther("10"));

      const [aliceBalance2, bobBalance2] = await Promise.all([
        volatilePair.balanceOf(alice.address),
        volatilePair.balanceOf(bob.address),
      ]);

      expect(bobBalance2).to.be.equal(parseEther("10"));
      expect(aliceBalance2).to.be.equal(aliceBalance.sub(bobBalance2));

      await expect(
        volatilePair.connect(bob).transfer(alice.address, parseEther("10.01"))
      ).to.be.reverted;
    });

    it("allows a user to spend his/her allowance", async () => {
      await Promise.all([
        tokenA.connect(alice).transfer(volatilePair.address, parseEther("100")),
        tokenB.connect(alice).transfer(volatilePair.address, parseEther("50")),
      ]);

      await volatilePair.mint(alice.address);

      await volatilePair.connect(alice).approve(bob.address, parseEther("10"));

      // overspend his allowance
      await expect(
        volatilePair
          .connect(bob)
          .transferFrom(alice.address, owner.address, parseEther("10.1"))
      ).to.be.reverted;

      const [aliceBalance, ownerBalance, bobAllowance] = await Promise.all([
        volatilePair.balanceOf(alice.address),
        volatilePair.balanceOf(owner.address),
        volatilePair.allowance(alice.address, bob.address),
      ]);

      expect(bobAllowance).to.be.equal(parseEther("10"));
      expect(ownerBalance).to.be.equal(0);

      await expect(
        volatilePair
          .connect(bob)
          .transferFrom(alice.address, owner.address, parseEther("10"))
      )
        .to.emit(volatilePair, "Transfer")
        .withArgs(alice.address, owner.address, parseEther("10"))
        .to.emit(volatilePair, "Approval")
        .withArgs(alice.address, bob.address, 0);

      const [aliceBalance2, ownerBalance2, bobAllowance2] = await Promise.all([
        volatilePair.balanceOf(alice.address),
        volatilePair.balanceOf(owner.address),
        volatilePair.allowance(alice.address, bob.address),
      ]);

      expect(bobAllowance2).to.be.equal(0);
      expect(ownerBalance2).to.be.equal(parseEther("10"));
      expect(aliceBalance2).to.be.equal(aliceBalance.sub(parseEther("10")));

      await volatilePair
        .connect(alice)
        .approve(bob.address, ethers.constants.MaxUint256);

      await expect(
        volatilePair
          .connect(bob)
          .transferFrom(alice.address, owner.address, parseEther("10"))
      ).to.not.emit(volatilePair, "Approval");

      const [aliceBalance3, ownerBalance3, bobAllowance3] = await Promise.all([
        volatilePair.balanceOf(alice.address),
        volatilePair.balanceOf(owner.address),
        volatilePair.allowance(alice.address, bob.address),
      ]);

      expect(bobAllowance3).to.be.equal(ethers.constants.MaxUint256);
      expect(ownerBalance3).to.be.equal(parseEther("10").add(ownerBalance2));
      expect(aliceBalance3).to.be.equal(aliceBalance2.sub(parseEther("10")));

      await expect(
        volatilePair
          .connect(alice)
          .transferFrom(alice.address, owner.address, parseEther("10"))
      ).to.not.emit(volatilePair, "Approval");

      const [aliceBalance4, ownerBalance4] = await Promise.all([
        volatilePair.balanceOf(alice.address),
        volatilePair.balanceOf(owner.address),
      ]);

      expect(ownerBalance4).to.be.equal(parseEther("10").add(ownerBalance3));
      expect(aliceBalance4).to.be.equal(aliceBalance3.sub(parseEther("10")));
    });

    it("reverts if the permit has expired", async () => {
      const blockTimestamp = await (
        await ethers.provider.getBlock(await ethers.provider.getBlockNumber())
      ).timestamp;

      await expect(
        volatilePair.permit(
          alice.address,
          bob.address,
          0,
          blockTimestamp - 1,
          0,
          ethers.constants.HashZero,
          ethers.constants.HashZero
        )
      ).to.revertedWith("Pair: Expired");
    });

    it("reverts if the recovered address is wrong", async () => {
      const chainId = network.config.chainId || 0;
      const name = await volatilePair.name();
      const domainSeparator = getPairDomainSeparator(
        volatilePair.address,
        name,
        chainId
      );

      const digest = getPairDigest(
        domainSeparator,
        alice.address,
        bob.address,
        parseEther("100"),
        0,
        1700587613
      );

      const { v, r, s } = getECSign(PRIVATE_KEYS[1], digest);

      const bobAllowance = await volatilePair.allowance(
        alice.address,
        bob.address
      );

      expect(bobAllowance).to.be.equal(0);

      await Promise.all([
        expect(
          volatilePair
            .connect(bob)
            .permit(
              owner.address,
              bob.address,
              parseEther("100"),
              1700587613,
              v,
              r,
              s
            )
        ).to.revertedWith("Pair: invalid signature"),
        expect(
          volatilePair
            .connect(bob)
            .permit(
              owner.address,
              bob.address,
              parseEther("100"),
              1700587613,
              0,
              ethers.constants.HashZero,
              ethers.constants.HashZero
            )
        ).to.revertedWith("Pair: invalid signature"),
      ]);
    });

    it("allows for permit call to give allowance", async () => {
      const chainId = network.config.chainId || 0;
      const name = await volatilePair.name();
      const domainSeparator = getPairDomainSeparator(
        volatilePair.address,
        name,
        chainId
      );

      const digest = getPairDigest(
        domainSeparator,
        alice.address,
        bob.address,
        parseEther("100"),
        0,
        1700587613
      );

      const { v, r, s } = getECSign(PRIVATE_KEYS[1], digest);

      const bobAllowance = await volatilePair.allowance(
        alice.address,
        bob.address
      );
      expect(bobAllowance).to.be.equal(0);

      await expect(
        volatilePair
          .connect(bob)
          .permit(
            alice.address,
            bob.address,
            parseEther("100"),
            1700587613,
            v,
            r,
            s
          )
      )
        .to.emit(volatilePair, "Approval")
        .withArgs(alice.address, bob.address, parseEther("100"));

      const bobAllowance2 = await volatilePair.allowance(
        alice.address,
        bob.address
      );
      expect(bobAllowance2).to.be.equal(parseEther("100"));
    });
  });

  it("returns the tokens sorted", async () => {
    const [token0Address] = sortTokens(tokenA.address, tokenB.address);

    const token0 = token0Address === tokenA.address ? tokenA : tokenB;
    const token1 = token0Address === tokenA.address ? tokenB : tokenA;

    const tokens = await volatilePair.tokens();

    expect(tokens[0]).to.be.equal(token0.address);
    expect(tokens[1]).to.be.equal(token1.address);
  });

  describe("Oracle functionality", () => {
    it("reverts if the first observation is stale", async () => {
      await expect(
        volatilePair.getTokenPrice(tokenA.address, parseEther("1"))
      ).to.revertedWith("Pair: Missing observation");
    });

    it("returns a TWAP", async () => {
      // * 1 Token A === 0.5 Token B
      // * 2 Token B === 2 Token A
      await Promise.all([
        tokenA.connect(alice).transfer(volatilePair.address, parseEther("500")),
        tokenB.connect(alice).transfer(volatilePair.address, parseEther("250")),
      ]);

      await volatilePair.mint(alice.address);

      const amountOut = await volatilePair.getAmountOut(
        tokenA.address,
        parseEther("2")
      );

      await tokenA
        .connect(alice)
        .transfer(volatilePair.address, parseEther("2"));

      const amount0Out = tokenA.address > tokenB.address ? amountOut : 0;
      const amount1Out = tokenA.address > tokenB.address ? 0 : amountOut;

      await volatilePair
        .connect(alice)
        .swap(amount0Out, amount1Out, alice.address, []);

      await expect(
        volatilePair.getTokenPrice(tokenA.address, parseEther("1"))
      ).to.revertedWith("Pair: Missing observation");

      const advanceAndSwap = async () => {
        for (let i = 0; i < 13; i++) {
          await advanceBlockAndTime(PERIOD_SIZE + 1, ethers);

          const amountOut = await volatilePair.getAmountOut(
            tokenA.address,
            parseEther("1")
          );

          await tokenA
            .connect(alice)
            .transfer(volatilePair.address, parseEther("1"));

          const amount0Out = tokenA.address > tokenB.address ? amountOut : 0;
          const amount1Out = tokenA.address > tokenB.address ? 0 : amountOut;

          await volatilePair
            .connect(alice)
            .swap(amount0Out, amount1Out, alice.address, []);
        }
      };

      await advanceAndSwap();

      await network.provider.send("evm_setAutomine", [false]);

      const blockTimestamp = await (
        await ethers.provider.getBlock(await ethers.provider.getBlockNumber())
      ).timestamp;

      const [reserve0Cumulative, reserve1Cumulative] =
        await volatilePair.currentCumulativeReserves();

      const firstObservation = await volatilePair.getFirstObservationInWindow();

      const timeElapsed = ethers.BigNumber.from(blockTimestamp + 100).sub(
        firstObservation.timestamp
      );

      const reserve0 = reserve0Cumulative
        .sub(firstObservation.reserve0Cumulative)
        .div(timeElapsed);

      const reserve1 = reserve1Cumulative
        .sub(firstObservation.reserve1Cumulative)
        .div(timeElapsed);

      const reserveA = tokenA.address > tokenB.address ? reserve1 : reserve0;
      const reserveB = tokenA.address > tokenB.address ? reserve0 : reserve1;

      await network.provider.send("evm_increaseTime", [100]);

      const tx = volatilePair.getTokenPrice(tokenA.address, parseEther("1"));

      await network.provider.send("evm_mine");
      await network.provider.send("evm_setAutomine", [true]);

      const price = await tx;

      expect(price).to.be.closeTo(
        parseEther("1")
          .mul(reserveB)
          .div(reserveA.add(parseEther("1"))),
        parseEther("0.0001")
      );

      // * 86400 is the window size
      await advanceBlockAndTime(86400, ethers);

      await expect(
        volatilePair.getTokenPrice(tokenA.address, parseEther("1"))
      ).to.revertedWith("Pair: Missing observation");
    });
  });

  describe("function: mint", () => {
    it("reverts if you do not send enough liquidity", async () => {
      await expect(volatilePair.mint(alice.address)).to.reverted;

      await tokenA
        .connect(alice)
        .transfer(volatilePair.address, parseEther("12"));

      await expect(volatilePair.mint(alice.address)).to.reverted;

      await Promise.all([
        tokenA.connect(alice).transfer(volatilePair.address, parseEther("12")),
        tokenB.connect(alice).transfer(volatilePair.address, parseEther("5")),
      ]);

      await volatilePair.mint(alice.address);

      tokenA.connect(alice).transfer(volatilePair.address, parseEther("12"));

      await expect(volatilePair.mint(alice.address)).to.revertedWith(
        "Pair: low liquidity"
      );
    });

    it("has a reentrancy guard", async () => {
      const brokenToken = (await deploy("ERC20RMint", [
        "Broken Token",
        "BT",
      ])) as ERC20RMint;

      await factory.createPair(tokenA.address, brokenToken.address, false);
      const pairAddress = await factory.getPair(
        tokenA.address,
        brokenToken.address,
        false
      );

      const brokenPair = (await ethers.getContractFactory("Pair")).attach(
        pairAddress
      );

      await brokenToken.mint(alice.address, parseEther("100"));

      await Promise.all([
        tokenA.connect(alice).transfer(brokenPair.address, parseEther("10")),
        brokenToken
          .connect(alice)
          .transfer(brokenPair.address, parseEther("10")),
      ]);

      await expect(brokenPair.mint(alice.address)).to.revertedWith(
        "Pair: Reentrancy"
      );
    });

    it("mints the right amount of LP tokens", async () => {
      const [aliceBalance, addressZeroBalance] = await Promise.all([
        volatilePair.balanceOf(alice.address),
        volatilePair.balanceOf(ethers.constants.AddressZero),
      ]);

      expect(aliceBalance).to.be.equal(0);
      expect(addressZeroBalance).to.be.equal(0);

      await Promise.all([
        tokenA.connect(alice).transfer(volatilePair.address, parseEther("100")),
        tokenB.connect(alice).transfer(volatilePair.address, parseEther("50")),
      ]);

      const amount0 =
        tokenA.address > tokenB.address ? parseEther("50") : parseEther("100");
      const amount1 =
        tokenA.address > tokenB.address ? parseEther("100") : parseEther("50");

      await expect(volatilePair.mint(alice.address))
        .to.emit(volatilePair, "Mint")
        .withArgs(owner.address, amount0, amount1);

      const [aliceBalance2, addressZeroBalance2] = await Promise.all([
        volatilePair.balanceOf(alice.address),
        volatilePair.balanceOf(ethers.constants.AddressZero),
      ]);

      expect(aliceBalance2).to.be.equal(
        sqrt(amount0.mul(amount1)).sub(MINIMUM_LIQUIDITY)
      );
      expect(addressZeroBalance2).to.be.equal(MINIMUM_LIQUIDITY);

      await Promise.all([
        tokenA.connect(alice).transfer(volatilePair.address, parseEther("150")),
        tokenB.connect(alice).transfer(volatilePair.address, parseEther("100")),
      ]);

      const _amount0 =
        tokenA.address > tokenB.address ? parseEther("100") : parseEther("150");
      const _amount1 =
        tokenA.address > tokenB.address ? parseEther("150") : parseEther("100");

      await expect(volatilePair.mint(alice.address))
        .to.emit(volatilePair, "Mint")
        .withArgs(owner.address, _amount0, _amount1);

      const [aliceBalance3, addressZeroBalance3] = await Promise.all([
        volatilePair.balanceOf(alice.address),
        volatilePair.balanceOf(ethers.constants.AddressZero),
      ]);

      expect(aliceBalance3).to.be.equal(
        min(
          _amount0.mul(MINIMUM_LIQUIDITY.add(aliceBalance2)).div(amount0),
          _amount1.mul(MINIMUM_LIQUIDITY.add(aliceBalance2)).div(amount1)
        ).add(aliceBalance2)
      );
      expect(addressZeroBalance3).to.be.equal(MINIMUM_LIQUIDITY);
    });

    it("updates the fees earned on mint", async () => {
      await Promise.all([
        tokenA
          .connect(alice)
          .transfer(volatilePair.address, parseEther("1000")),
        tokenB.connect(alice).transfer(volatilePair.address, parseEther("500")),
      ]);

      await expect(volatilePair.mint(alice.address));

      const swapTokenA = async () => {
        for (let i = 0; i < 4; i++) {
          const amountOut = await volatilePair.getAmountOut(
            tokenA.address,
            parseEther("10")
          );

          await tokenA
            .connect(alice)
            .transfer(volatilePair.address, parseEther("10"));

          const amount0Out = tokenA.address > tokenB.address ? amountOut : 0;
          const amount1Out = tokenA.address > tokenB.address ? 0 : amountOut;

          await volatilePair
            .connect(alice)
            .swap(amount0Out, amount1Out, alice.address, []);
        }
      };

      const swapTokenB = async () => {
        for (let i = 0; i < 4; i++) {
          const amountOut = await volatilePair.getAmountOut(
            tokenB.address,
            parseEther("10")
          );

          await tokenB
            .connect(alice)
            .transfer(volatilePair.address, parseEther("10"));

          const amount0Out = tokenA.address > tokenB.address ? 0 : amountOut;
          const amount1Out = tokenA.address > tokenB.address ? amountOut : 0;

          await volatilePair
            .connect(alice)
            .swap(amount0Out, amount1Out, alice.address, []);
        }
      };

      await swapTokenA();
      await swapTokenB();

      const [bobSupplyIndex0, bobSupplyIndex1] = await Promise.all([
        volatilePair.supplyIndex0(bob.address),
        volatilePair.supplyIndex1(bob.address),
      ]);

      expect(bobSupplyIndex0).to.be.equal(0);
      expect(bobSupplyIndex1).to.be.equal(0);

      await Promise.all([
        tokenA.connect(bob).transfer(volatilePair.address, parseEther("150")),
        tokenB.connect(bob).transfer(volatilePair.address, parseEther("100")),
      ]);

      await expect(volatilePair.mint(bob.address)).to.emit(
        volatilePair,
        "Sync"
      );

      const [
        bobSupply2Index0,
        bobSupply2Index1,
        indexTwo0,
        indexTwo1,
        bobClaimableTwo0,
        bobClaimableTwo1,
      ] = await Promise.all([
        volatilePair.supplyIndex0(bob.address),
        volatilePair.supplyIndex1(bob.address),
        volatilePair.index0(),
        volatilePair.index1(),
        volatilePair.claimable0(bob.address),
        volatilePair.claimable1(bob.address),
      ]);

      expect(indexTwo0.gt(0)).to.be.equal(true);
      expect(indexTwo1.gt(0)).to.be.equal(true);
      expect(bobSupply2Index0).to.be.equal(indexTwo0);
      expect(bobSupply2Index1).to.be.equal(indexTwo1);
      expect(bobClaimableTwo0).to.be.equal(0);
      expect(bobClaimableTwo1).to.be.equal(0);
    });

    it("updates the reserves after every mint", async () => {
      await Promise.all([
        tokenA
          .connect(alice)
          .transfer(volatilePair.address, parseEther("1000")),
        tokenB.connect(alice).transfer(volatilePair.address, parseEther("500")),
      ]);

      const [reserve0, reserve1, blockTimestampLast] =
        await volatilePair.getReserves();

      expect(reserve0).to.be.equal(0);
      expect(reserve1).to.be.equal(0);

      await volatilePair.mint(alice.address);

      const [reserveTwo0, reserveTwo1, blockTimestampLastTwo] =
        await volatilePair.getReserves();

      const amount0 =
        tokenA.address > tokenB.address
          ? parseEther("500")
          : parseEther("1000");

      const amount1 =
        tokenA.address > tokenB.address
          ? parseEther("1000")
          : parseEther("500");

      expect(blockTimestampLastTwo.gt(blockTimestampLast)).to.be.equal(true);
      expect(reserveTwo0).to.be.equal(amount0);
      expect(reserveTwo1).to.be.equal(amount1);
    });
  });

  describe("function: burn", () => {
    it("reverts if there is no supply or there are no tokens to burn", async () => {
      await expect(volatilePair.burn(alice.address)).to.reverted;

      await Promise.all([
        tokenA
          .connect(alice)
          .transfer(volatilePair.address, parseEther("1000")),
        tokenB.connect(alice).transfer(volatilePair.address, parseEther("500")),
      ]);

      await volatilePair.mint(alice.address);

      await expect(volatilePair.burn(alice.address)).to.revertedWith(
        "Pair: not enough liquidity"
      );
    });

    it("reverts if there is a reentrancy attempt", async () => {
      const brokenToken = (await deploy("ERC20RMint", [
        "Broken Token",
        "BT",
      ])) as ERC20RMint;

      await factory.createPair(tokenA.address, brokenToken.address, false);
      const pairAddress = await factory.getPair(
        tokenA.address,
        brokenToken.address,
        false
      );

      const brokenPair = (await ethers.getContractFactory("Pair")).attach(
        pairAddress
      );

      await brokenToken.mint(alice.address, parseEther("100"));

      await Promise.all([
        tokenA.connect(alice).transfer(brokenPair.address, parseEther("10")),
        brokenToken
          .connect(alice)
          .transfer(brokenPair.address, parseEther("10")),
      ]);

      await expect(brokenPair.burn(alice.address)).to.revertedWith(
        "Pair: Reentrancy"
      );
    });

    it("burns the right amount of tokens", async () => {
      await Promise.all([
        tokenA
          .connect(alice)
          .transfer(volatilePair.address, parseEther("1000")),
        tokenB.connect(alice).transfer(volatilePair.address, parseEther("500")),
      ]);

      await volatilePair.mint(alice.address);

      const [
        aliceTokenABalance,
        aliceTokenBBalance,
        aliceVolatilePairBalance,
        totalSupply,
      ] = await Promise.all([
        tokenA.balanceOf(alice.address),
        tokenB.balanceOf(alice.address),
        volatilePair.balanceOf(alice.address),
        volatilePair.totalSupply(),
      ]);

      const tokensToBurn = aliceVolatilePairBalance.div(3);

      await volatilePair
        .connect(alice)
        .transfer(volatilePair.address, tokensToBurn);

      const balance0 =
        tokenA.address > tokenB.address
          ? parseEther("500")
          : parseEther("1000");

      const balance1 =
        tokenA.address > tokenB.address
          ? parseEther("1000")
          : parseEther("500");

      const amount0 = tokensToBurn.mul(balance0).div(totalSupply);
      const amount1 = tokensToBurn.mul(balance1).div(totalSupply);

      await expect(volatilePair.burn(alice.address))
        .to.emit(volatilePair, "Burn")
        .withArgs(owner.address, amount0, amount1, alice.address);

      const [aliceTokenABalance2, aliceTokenBBalance2, volatilePairBalance2] =
        await Promise.all([
          tokenA.balanceOf(alice.address),
          tokenB.balanceOf(alice.address),
          volatilePair.balanceOf(volatilePair.address),
        ]);

      const aliceToken0Balance =
        tokenA.address > tokenB.address
          ? aliceTokenBBalance
          : aliceTokenABalance;

      const aliceToken1Balance =
        tokenA.address > tokenB.address
          ? aliceTokenABalance
          : aliceTokenBBalance;

      const aliceToken0Balance2 =
        tokenA.address > tokenB.address
          ? aliceTokenBBalance2
          : aliceTokenABalance2;

      const aliceToken1Balance2 =
        tokenA.address > tokenB.address
          ? aliceTokenABalance2
          : aliceTokenBBalance2;

      expect(aliceToken0Balance2).to.be.equal(aliceToken0Balance.add(amount0));
      expect(aliceToken1Balance2).to.be.equal(aliceToken1Balance.add(amount1));
      expect(volatilePairBalance2).to.be.equal(0);
    });

    it("updates the fees rewards on burn", async () => {
      await Promise.all([
        tokenA
          .connect(alice)
          .transfer(volatilePair.address, parseEther("1000")),
        tokenB.connect(alice).transfer(volatilePair.address, parseEther("500")),
      ]);

      await volatilePair.mint(alice.address);

      const swapTokenA = async () => {
        for (let i = 0; i < 4; i++) {
          const amountOut = await volatilePair.getAmountOut(
            tokenA.address,
            parseEther("10")
          );

          await tokenA
            .connect(alice)
            .transfer(volatilePair.address, parseEther("10"));

          const amount0Out = tokenA.address > tokenB.address ? amountOut : 0;
          const amount1Out = tokenA.address > tokenB.address ? 0 : amountOut;

          await volatilePair
            .connect(alice)
            .swap(amount0Out, amount1Out, alice.address, []);
        }
      };

      const swapTokenB = async () => {
        for (let i = 0; i < 4; i++) {
          const amountOut = await volatilePair.getAmountOut(
            tokenB.address,
            parseEther("10")
          );

          await tokenB
            .connect(alice)
            .transfer(volatilePair.address, parseEther("10"));

          const amount0Out = tokenA.address > tokenB.address ? 0 : amountOut;
          const amount1Out = tokenA.address > tokenB.address ? amountOut : 0;

          await volatilePair
            .connect(alice)
            .swap(amount0Out, amount1Out, alice.address, []);
        }
      };

      const aliceVolatilePairBalance = await volatilePair.balanceOf(
        alice.address
      );

      const tokensToBurn = aliceVolatilePairBalance.div(3);

      await volatilePair
        .connect(alice)
        .transfer(volatilePair.address, tokensToBurn);

      await swapTokenA();
      await swapTokenB();

      const [
        index0,
        index1,
        supplyIndex0,
        supplyIndex1,
        claimable0,
        claimable1,
      ] = await Promise.all([
        volatilePair.index0(),
        volatilePair.index1(),
        volatilePair.supplyIndex0(volatilePair.address),
        volatilePair.supplyIndex1(volatilePair.address),
        volatilePair.claimable0(volatilePair.address),
        volatilePair.claimable1(volatilePair.address),
      ]);

      expect(index0.gt(0)).to.be.equal(true);
      expect(index1.gt(0)).to.be.equal(true);
      expect(supplyIndex0).to.be.equal(0);
      expect(supplyIndex1).to.be.equal(0);
      expect(claimable0).to.be.equal(0);
      expect(claimable1).to.be.equal(0);

      await volatilePair.burn(alice.address);

      const [supplyIndexTwo0, supplyIndexTwo1, claimableTwo0, claimableTwo1] =
        await Promise.all([
          volatilePair.supplyIndex0(volatilePair.address),
          volatilePair.supplyIndex1(volatilePair.address),
          volatilePair.claimable0(volatilePair.address),
          volatilePair.claimable1(volatilePair.address),
        ]);

      expect(supplyIndexTwo0).to.be.equal(index0);
      expect(supplyIndexTwo1).to.be.equal(index1);
      expect(claimableTwo0).to.be.equal(
        tokensToBurn.mul(index0).div(parseEther("1"))
      );
      expect(claimableTwo1).to.be.equal(
        tokensToBurn.mul(index1).div(parseEther("1"))
      );
    });

    it("updates the reserves after each burn", async () => {
      await Promise.all([
        tokenA
          .connect(alice)
          .transfer(volatilePair.address, parseEther("1000")),
        tokenB.connect(alice).transfer(volatilePair.address, parseEther("500")),
      ]);

      await expect(volatilePair.mint(alice.address));

      const [
        aliceVolatilePairBalance,
        totalSupply,
        [reserve0, reserve1, blockTimestampLast],
      ] = await Promise.all([
        volatilePair.balanceOf(alice.address),
        volatilePair.totalSupply(),
        volatilePair.getReserves(),
      ]);

      const tokensToBurn = aliceVolatilePairBalance.div(3);

      await volatilePair
        .connect(alice)
        .transfer(volatilePair.address, tokensToBurn);

      const balance0 =
        tokenA.address > tokenB.address
          ? parseEther("500")
          : parseEther("1000");

      const balance1 =
        tokenA.address > tokenB.address
          ? parseEther("1000")
          : parseEther("500");

      const amount0 = tokensToBurn.mul(balance0).div(totalSupply);
      const amount1 = tokensToBurn.mul(balance1).div(totalSupply);

      expect(reserve0).to.be.equal(balance0);
      expect(reserve1).to.be.equal(balance1);

      await expect(volatilePair.burn(alice.address)).to.emit(
        volatilePair,
        "Sync"
      );

      const [reserveTwo0, reserveTwo1, blockTimestampLastTwo] =
        await volatilePair.getReserves();

      expect(reserveTwo0).to.be.equal(reserve0.sub(amount0));
      expect(reserveTwo1).to.be.equal(reserve1.sub(amount1));
      expect(blockTimestampLastTwo.gt(blockTimestampLast)).to.be.equal(true);
    });
  });

  it("updates the fee rewards for the sender and recipient on transfer", async () => {
    await Promise.all([
      tokenA.connect(alice).transfer(volatilePair.address, parseEther("1000")),
      tokenB.connect(alice).transfer(volatilePair.address, parseEther("500")),
    ]);

    await volatilePair.mint(alice.address);

    await Promise.all([
      tokenA.connect(bob).transfer(volatilePair.address, parseEther("700")),
      tokenB.connect(bob).transfer(volatilePair.address, parseEther("250")),
    ]);

    await volatilePair.mint(bob.address);

    const swapTokenA = async () => {
      for (let i = 0; i < 4; i++) {
        const amountOut = await volatilePair.getAmountOut(
          tokenA.address,
          parseEther("10")
        );

        await tokenA
          .connect(alice)
          .transfer(volatilePair.address, parseEther("10"));

        const amount0Out = tokenA.address > tokenB.address ? amountOut : 0;
        const amount1Out = tokenA.address > tokenB.address ? 0 : amountOut;

        await volatilePair
          .connect(alice)
          .swap(amount0Out, amount1Out, alice.address, []);
      }
    };

    const swapTokenB = async () => {
      for (let i = 0; i < 4; i++) {
        const amountOut = await volatilePair.getAmountOut(
          tokenB.address,
          parseEther("10")
        );

        await tokenB
          .connect(alice)
          .transfer(volatilePair.address, parseEther("10"));

        const amount0Out = tokenA.address > tokenB.address ? 0 : amountOut;
        const amount1Out = tokenA.address > tokenB.address ? amountOut : 0;

        await volatilePair
          .connect(alice)
          .swap(amount0Out, amount1Out, alice.address, []);
      }
    };

    await swapTokenA();
    await swapTokenB();

    const [
      [aliceSupplyIndex0, aliceSupplyIndex1, aliceClaimable0, aliceClaimable1],
      [bobSupplyIndex0, bobSupplyIndex1, bobClaimable0, bobClaimable1],
      volatilePairAliceBalance,
      volatilePairBobBalance,
    ] = await Promise.all([
      volatilePair.getAccountFeesRewards(alice.address),
      volatilePair.getAccountFeesRewards(bob.address),
      volatilePair.balanceOf(alice.address),
      volatilePair.balanceOf(bob.address),
    ]);

    expect(aliceSupplyIndex0).to.be.equal(0);
    expect(aliceSupplyIndex1).to.be.equal(0);
    expect(aliceClaimable0).to.be.equal(0);
    expect(aliceClaimable1).to.be.equal(0);

    expect(bobSupplyIndex0).to.be.equal(0);
    expect(bobSupplyIndex1).to.be.equal(0);
    expect(bobClaimable0).to.be.equal(0);
    expect(bobClaimable1).to.be.equal(0);

    const tokensToSend = volatilePairAliceBalance.div(3);

    await volatilePair.connect(alice).transfer(bob.address, tokensToSend);

    const [
      [
        aliceSupplyIndexTwo0,
        aliceSupplyIndexTwo1,
        aliceClaimableTwo0,
        aliceClaimableTwo1,
      ],
      [
        bobSupplyIndexTwo0,
        bobSupplyIndexTwo1,
        bobClaimableTwo0,
        bobClaimableTwo1,
      ],
      index0,
      index1,
    ] = await Promise.all([
      volatilePair.getAccountFeesRewards(alice.address),
      volatilePair.getAccountFeesRewards(bob.address),
      volatilePair.index0(),
      volatilePair.index1(),
    ]);

    expect(aliceSupplyIndexTwo0).to.be.equal(index0);
    expect(aliceSupplyIndexTwo1).to.be.equal(index1);
    expect(aliceClaimableTwo0).to.be.equal(
      volatilePairAliceBalance.mul(index0).div(parseEther("1"))
    );
    expect(aliceClaimableTwo1).to.be.equal(
      volatilePairAliceBalance.mul(index1).div(parseEther("1"))
    );

    expect(bobSupplyIndexTwo0).to.be.equal(index0);
    expect(bobSupplyIndexTwo1).to.be.equal(index1);
    expect(bobClaimableTwo0).to.be.equal(
      volatilePairBobBalance.mul(index0).div(parseEther("1"))
    );
    expect(bobClaimableTwo1).to.be.equal(
      volatilePairBobBalance.mul(index1).div(parseEther("1"))
    );
  });

  describe("function: skim", () => {
    it("reverts if the caller tries to reenter", async () => {
      const brokenToken = (await deploy("ERC20RMint", [
        "Broken Token",
        "BT",
      ])) as ERC20RMint;

      await factory.createPair(tokenA.address, brokenToken.address, false);
      const pairAddress = await factory.getPair(
        tokenA.address,
        brokenToken.address,
        false
      );

      const brokenPair = (await ethers.getContractFactory("Pair")).attach(
        pairAddress
      );

      await brokenToken.mint(alice.address, parseEther("100"));

      await Promise.all([
        tokenA.connect(alice).transfer(brokenPair.address, parseEther("10")),
        brokenToken
          .connect(alice)
          .transfer(brokenPair.address, parseEther("10")),
      ]);

      await expect(brokenPair.skim(alice.address)).to.revertedWith(
        "Pair: Reentrancy"
      );
    });
    it("forces the reserves to match the balances by sending", async () => {
      await Promise.all([
        tokenA
          .connect(alice)
          .transfer(volatilePair.address, parseEther("1000")),
        tokenB.connect(alice).transfer(volatilePair.address, parseEther("500")),
      ]);

      await volatilePair.mint(alice.address);

      await Promise.all([
        tokenA.connect(alice).transfer(volatilePair.address, parseEther("40")),
        tokenB.connect(alice).transfer(volatilePair.address, parseEther("15")),
      ]);

      const [[reserve0, reserve1], tokenABalance, tokenBBalance] =
        await Promise.all([
          volatilePair.getReserves(),
          tokenA.balanceOf(volatilePair.address),
          tokenB.balanceOf(volatilePair.address),
        ]);

      const balance0 =
        tokenA.address > tokenB.address ? tokenBBalance : tokenABalance;
      const balance1 =
        tokenA.address > tokenB.address ? tokenABalance : tokenBBalance;

      expect(balance0.gt(reserve0)).to.be.equal(true);
      expect(balance1.gt(reserve1)).to.be.equal(true);

      await expect(volatilePair.skim(owner.address))
        .to.emit(tokenA, "Transfer")
        .withArgs(volatilePair.address, owner.address, parseEther("40"))
        .to.emit(tokenB, "Transfer")
        .withArgs(volatilePair.address, owner.address, parseEther("15"));

      const [[reserveTwo0, reserveTwo1], tokenABalanceTwo, tokenBBalanceTwo] =
        await Promise.all([
          volatilePair.getReserves(),
          tokenA.balanceOf(volatilePair.address),
          tokenB.balanceOf(volatilePair.address),
        ]);

      const balanceTwo0 =
        tokenA.address > tokenB.address ? tokenBBalanceTwo : tokenABalanceTwo;
      const balanceTwo1 =
        tokenA.address > tokenB.address ? tokenABalanceTwo : tokenBBalanceTwo;

      expect(balanceTwo0.eq(reserveTwo0)).to.be.equal(true);
      expect(balanceTwo1.eq(reserveTwo1)).to.be.equal(true);
    });
  });

  describe("function: sync", () => {
    it("does not update the reserve cumulatives if no time has passed", async () => {
      await Promise.all([
        tokenA
          .connect(alice)
          .transfer(volatilePair.address, parseEther("1000")),
        tokenB.connect(alice).transfer(volatilePair.address, parseEther("500")),
      ]);

      await volatilePair.mint(alice.address);

      await network.provider.send("evm_setAutomine", [false]);

      const [reserveCumulative0, reserveCumulative1] = await Promise.all([
        volatilePair.reserve0CumulativeLast(),
        volatilePair.reserve1CumulativeLast(),
      ]);

      await network.provider.send("evm_increaseTime", [27]);

      await volatilePair.sync();
      await volatilePair.sync();

      await network.provider.send("evm_mine");
      await network.provider.send("evm_setAutomine", [true]);

      const [reserveCumulativeTwo0, reserveCumulativeTwo1] = await Promise.all([
        volatilePair.reserve0CumulativeLast(),
        volatilePair.reserve1CumulativeLast(),
      ]);

      const reserve0 =
        tokenA.address > tokenB.address
          ? parseEther("500")
          : parseEther("1000");

      const reserve1 =
        tokenA.address > tokenB.address
          ? parseEther("1000")
          : parseEther("500");

      expect(reserveCumulativeTwo0).to.be.equal(
        reserveCumulative0.add(reserve0.mul(27))
      );

      expect(reserveCumulativeTwo1).to.be.equal(
        reserveCumulative1.add(reserve1.mul(27))
      );
    });

    it(`only updates an observation every ${PERIOD_SIZE} seconds`, async () => {
      await Promise.all([
        tokenA
          .connect(alice)
          .transfer(volatilePair.address, parseEther("1000")),
        tokenB.connect(alice).transfer(volatilePair.address, parseEther("500")),
      ]);

      await volatilePair.mint(alice.address);

      await advanceBlockAndTime(PERIOD_SIZE, ethers);

      await volatilePair.sync();
      const blockTimestamp = (
        await ethers.provider.getBlock(await ethers.provider.getBlockNumber())
      ).timestamp;

      const observation = await volatilePair.observations(
        await volatilePair.observationIndexOf(blockTimestamp)
      );

      await advanceBlockAndTime(PERIOD_SIZE / 2, ethers);

      await volatilePair.sync();

      const [observationIndex, reserve0CumulativeLast, reserve1CumulativeLast] =
        await Promise.all([
          volatilePair.observationIndexOf(blockTimestamp),
          volatilePair.reserve0CumulativeLast(),
          volatilePair.reserve1CumulativeLast(),
        ]);

      const observationTwo = await volatilePair.observations(observationIndex);

      expect(observationTwo.timestamp).to.be.equal(observation.timestamp);
      expect(observationTwo.reserve0Cumulative).to.be.equal(
        observation.reserve0Cumulative
      );
      expect(observationTwo.reserve1Cumulative).to.be.equal(
        observation.reserve1Cumulative
      );

      expect(
        reserve0CumulativeLast.gt(observationTwo.reserve0Cumulative)
      ).to.be.equal(true);
      expect(
        reserve1CumulativeLast.gt(observationTwo.reserve1Cumulative)
      ).to.be.equal(true);
    });

    it("updates the reserves and blocktimestampLast", async () => {
      await Promise.all([
        tokenA
          .connect(alice)
          .transfer(volatilePair.address, parseEther("1000")),
        tokenB.connect(alice).transfer(volatilePair.address, parseEther("500")),
      ]);

      await volatilePair.mint(alice.address);

      const [reserve0, reserve1, blocktimestampLast] =
        await volatilePair.getReserves();

      const amount0 =
        tokenA.address > tokenB.address
          ? parseEther("500")
          : parseEther("1000");

      const amount1 =
        tokenA.address > tokenB.address
          ? parseEther("1000")
          : parseEther("500");

      expect(reserve0).to.be.equal(amount0);
      expect(reserve1).to.be.equal(amount1);

      await Promise.all([
        tokenA.connect(alice).transfer(volatilePair.address, parseEther("20")),
        tokenB.connect(alice).transfer(volatilePair.address, parseEther("70")),
      ]);

      const additionalAmount0 =
        tokenA.address > tokenB.address ? parseEther("70") : parseEther("20");

      const additionalAmount1 =
        tokenA.address > tokenB.address ? parseEther("20") : parseEther("70");

      await volatilePair.sync();

      const [reserveTwo0, reserveTwo1, blocktimestampLastTwo] =
        await volatilePair.getReserves();

      expect(reserveTwo0).to.be.equal(amount0.add(additionalAmount0));
      expect(reserveTwo1).to.be.equal(amount1.add(additionalAmount1));
      expect(blocktimestampLastTwo.gt(blocktimestampLast)).to.be.equal(true);
    });
  });
});
