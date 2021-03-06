import { Response, Request } from "express";
import {ConnectStripeArgs, LogInArgs} from "./types";
import { IResolvers } from "apollo-server-express";
import { Viewer, Database, User } from "../../../lib/types";
import {Google, Stripe} from "../../../lib/api";
import crypto from "crypto";
import {authorize} from "../../../lib/utils";
/**
 * 要写入的cookie字段
 */
const cookieOptions = {
  httpOnly: true, // 防止XSS攻击
  sameSite: true, // 防止CSRF攻击
  signed: true, //PUZZ:signed不理解这个字段
  secure: process.env.NODE_ENV === "development" ? false : true, // PUZZ: 不理解
};

const logInViaGoogle = async (
  code: string,
  token: string,
  db: Database,
  res: Response
): Promise<User | undefined> => {
  const { user } = await Google.logIn(code);
  if (!user) {
    throw new Error("谷歌登录失败");
  }
  console.log(`谷歌认证成功，开始提取需要的google用户信息`);

  // --- 提取google账号中的有用信息，不必care ---
  const userNamesList = user.names && user.names.length ? user.names : null;
  const userPhotosList = user.photos && user.photos.length ? user.photos : null;
  const userEmailsList =
    user.emailAddresses && user.emailAddresses.length
      ? user.emailAddresses
      : null;
  // User Display Name
  const userName = userNamesList ? userNamesList[0].displayName : null;
  // User Id
  const userId =
    userNamesList &&
    userNamesList[0].metadata &&
    userNamesList[0].metadata.source
      ? userNamesList[0].metadata.source.id
      : null;
  // User Avatar
  const userAvatar =
    userPhotosList && userPhotosList[0].url ? userPhotosList[0].url : null;
  // User Email
  const userEmail =
    userEmailsList && userEmailsList[0].value ? userEmailsList[0].value : null;
  if (!userId || !userName || !userAvatar || !userEmail) {
    throw new Error("谷歌用户数据出错");
  }
  // --- google账号数据输入处理完毕 ---

  // 从数据库中获取用户信息，如果已经存在则更新用户数据。
  const updateRes = await db.users.findOneAndUpdate(
    { _id: userId },
    {
      $set: {
        name: userName,
        avatar: userAvatar,
        contact: userEmail,
        token,
      },
    },
    { returnOriginal: false }
  );
  let viewer = updateRes.value;  
  if (!viewer) {
    console.log(`用户首次登录，需要向数据库存入该用户`);
    const insertResult = await db.users.insertOne({
      _id: userId,
      token,
      name: userName,
      avatar: userAvatar,
      contact: userEmail,
      income: 0,
      bookings: [],
      listings: [],
    });
    console.log(`存入用户数据成功`);
    viewer = insertResult.ops[0];
  }
  console.log(`开始向客户端写入cookie`)  
  res.cookie("viewer", userId, {
    ...cookieOptions,
    maxAge: 365 * 24 * 60 * 60 * 1000,
  });
  return viewer;
};
const logInViaCookie = async (
  token: string,
  db: Database,
  req: Request,
  res: Response
): Promise<User | undefined> => {
  // 检查数据库中该用户是否登录过
  const updateRes = await db.users.findOneAndUpdate(
    { _id: req.signedCookies.viewer },
    { $set: { token } },
    { returnOriginal: false }
  );
  let viewer = updateRes.value;
  // PUZZ: 没有从数据库中查到用户信息，为什么要清除这个cookie？
  if (!viewer) {
    res.clearCookie("viewer", cookieOptions);
  }
  return viewer;
};
export const viewerResolvers: IResolvers = {
  Query: {
    /**
     * 为OAuth登录提供 Google登录地址
     */
    authUrl: (): string => {
      try {
        return Google.authUrl;
      } catch (error) {
        throw new Error(`获取Google authUrl 出现错误${error}`);
      }
    },
  },
  Mutation: {
    logIn: async (
      _root: undefined,
      { input }: LogInArgs,
      { db, res, req }: { db: Database; req: Request; res: Response }
    ): Promise<Viewer> => {
      try {
        // 获取用户用于登录的code
        const code = input ? input.code : null;
        console.log(`登录授权码为: ${code}`);        
        const token = crypto.randomBytes(16).toString("hex");  
        console.log(`每次生成的token为:${token}`)      
        /**
         * 如果本次登录没有携带code，发生行为可能是如下之一：
         * 
         * - F5刷新页面，前端再次发起LogIn mutation
         * 
         * - 用户登录过后一段时间再次访问该网站
         * 
         * 将进行 cookie持久化登录 认证
         */        
        const viewer: User | undefined = code
          ? await logInViaGoogle(code, token, db, res)
          : await logInViaCookie(token, db, req, res);
        if (!viewer) {
          return { didRequest: true };
        }
        return {
          _id: viewer._id,
          token: viewer.token,
          avatar: viewer.avatar,
          walletId: viewer.walletId,
          didRequest: true,
        };
      } catch (error) {
        throw new Error(`登录失败: ${error}`);
      }
    },
    logOut: (
      _root: undefined,
      _args: {},
      { res }: { res: Response }
    ): Viewer => {
      try {
        // 用户注销时，手动清理cookie
        res.clearCookie("viewer", cookieOptions);
        return { didRequest: true };
      } catch (error) {
        throw new Error(`注销失败: ${error}`);
      }
    },
    connectStripe: async (
      _root: undefined,
      { input }: ConnectStripeArgs,
      { db, req }: { db: Database; req: Request }
    ): Promise<Viewer> => {
      try {
        const { code } = input;
        let viewer = await authorize(db, req);
        if (!viewer) {
          throw new Error("该用户没有权限连接到stripe");
        }
        const wallet = await Stripe.connect(code);
        if (!wallet) {
          throw new Error("stripe连接出错");
        }
        const updateRes = await db.users.findOneAndUpdate(
          { _id: viewer._id },
          { $set: { walletId: wallet.stripe_user_id } },
          { returnOriginal: false }
        );
        if (!updateRes.value) {
          throw new Error("DB更新用户数据出错，在connectStripe函数中");
        }
        viewer = updateRes.value;
        return {
          _id: viewer._id,
          token: viewer.token,
          avatar: viewer.avatar,
          walletId: viewer.walletId,
          didRequest: true
        };
      } catch (e) {
        throw new Error(`连接到stripe失败，全局捕获错误: ${e}`);
      }
    },
    /**
     *  该resolver的核心就是：修改database中保存的用户信息
     * @param _root
     * @param _args
     * @param db
     * @param req
     */
    disconnectStripe: async (
      _root: undefined,
      _args: {},
      { db, req }: { db: Database; req: Request }
    ): Promise<Viewer> => {
      try {
        let viewer = await authorize(db, req);
        if (!viewer) {
          throw new Error("viewer cannot be found");
        }


        const updateRes = await db.users.findOneAndUpdate(
          { _id: viewer._id },
          // @ts-ignore
          { $set: { walletId: null } },
          { returnOriginal: false }
        );

        if (!updateRes.value) {
          throw new Error("viewer could not be updated");
        }

        viewer = updateRes.value;

        return {
          _id: viewer._id,
          token: viewer.token,
          avatar: viewer.avatar,
          walletId: viewer.walletId,
          didRequest: true
        };
      } catch (error) {
        throw new Error(`Failed to disconnect with Stripe: ${error}`);
      }
    }
  },
  Viewer: {
    id: (viewer: Viewer): string | undefined => {
      return viewer._id;
    },
    hasWallet: (viewer: Viewer): boolean | undefined => {
      return viewer.walletId ? true : undefined;
    },
  },
};
