import { Context, Next, Random, Session } from "koishi";
import { h } from "koishi";

import { Config } from "./config";
import { getBotName, isChannelAllowed } from "./utils/toolkit";
import { ensurePromptFileExists, genSysPrompt } from "./utils/prompt";
import { SendQueue } from "./services/sendQueue";
import { AdapterSwitcher } from "./adapters";
import { initDatabase } from "./database";
import { AssistantMessage, SystemMessage, UserMessage } from "./adapters/creators/component";
import { processContent } from "./utils/content";
import { foldText } from "./utils/string";

export const name = "yesimbot";

export const usage = `
"Yes! I'm Bot!" 是一个能让你的机器人激活灵魂的插件。\n
使用请阅读 [Github README](https://github.com/HydroGest/YesImBot/blob/main/readme.md)，推荐使用 [GPTGOD](https://gptgod.online/#/register?invite_code=envrd6lsla9nydtipzrbvid2r) 提供的 GPT-4o-mini 模型以获得最高性价比。\n
官方交流 & 测试群：[857518324](http://qm.qq.com/cgi-bin/qm/qr?_wv=1027&k=k3O5_1kNFJMERGxBOj1ci43jHvLvfru9&authKey=TkOxmhIa6kEQxULtJ0oMVU9FxoY2XNiA%2B7bQ4K%2FNx5%2F8C8ToakYZeDnQjL%2B31Rx%2B&noverify=0&group_code=857518324)
`;

export { Config } from "./config";

export const DATABASE_NAME = name;

export const inject = {
  optional: ['qmanager', 'interactions', 'database']
}

export function apply(ctx: Context, config: Config) {
  initDatabase(ctx);
  let adapterSwitcher: AdapterSwitcher;
  const sendQueue = new SendQueue(ctx, config);

  ctx.on("ready", async () => {
    adapterSwitcher = new AdapterSwitcher(config.API.APIList, config.Parameters);
    if (!config.Settings.UpdatePromptOnLoad) return;
    ctx.logger.info("正在尝试更新 Prompt 文件...");
    await ensurePromptFileExists(
      config.Bot.PromptFileUrl[config.Bot.PromptFileSelected],
      config.Debug.DebugAsInfo ? ctx : null,
      true
    );
  });

  ctx.on("message-created", async (session) => {
    const channelId = session.channelId;
    if (isChannelAllowed(config.MemorySlot.SlotContains, channelId)) {
      await sendQueue.addMessage(session);
      ctx.logger.info(`New message received, guildId = ${channelId}, content = ${foldText(session.content, 1000)}`);

    }
  });

  ctx
    .command("清除记忆", "清除 BOT 对会话的记忆")
    .option("target", "-t <target:string> 指定要清除记忆的会话。使用 private:指定私聊会话，使用 all 或 private:all 分别清除所有群聊或私聊记忆", { authority: 3 })
    .option("person", "-p <person:string> 从所有会话中清除指定用户的记忆", { authority: 3 })
    .usage("注意：如果使用 清除记忆 <target> 来清除记忆而不带-t参数，将会清除当前会话的记忆！")
    .example([
        "清除记忆",
        "清除记忆 -t private:1234567890",
        "清除记忆 -t 987654321",
        "清除记忆 -t all",
        "清除记忆 -t private:all",
        "清除记忆 -p 1234567890",
      ].join("\n"))
    .action(async ({ session, options }) => {
      const msgDestination = session.guildId || session.channelId;
      let result = '';
      
      if (options.person) {
        // 按用户QQ清除记忆
        const cleared = await sendQueue.clearBySenderId(options.person);
        result = cleared
          ? `已清除关于用户 ${options.person} 的记忆`
          : `未找到关于用户 ${options.person} 的记忆`;
      } else {
        const clearGroupId = options.target || msgDestination;
        // 要清除的会话集合
        const targetGroups = clearGroupId
          .split(',')
          .map(g => g.trim())
          .filter(Boolean);
      
        const clearedIds = [];
        const messages = [];
      
        if (targetGroups.includes('private:all')) {
          const success = await sendQueue.clearPrivateAll();
          if (success) messages.push('已清除全部私聊消息');
        }
        if (targetGroups.includes('all')) {
          const success = await sendQueue.clearAll();
          if (success) messages.push('已清除全部群组消息');
        }
      
        for (const id of targetGroups) {
          if (id === 'all' || id === 'private:all') continue;
          const success = await sendQueue.clearChannel(id);
          if (success) clearedIds.push(id);
        }
      
        if (clearedIds.length > 0) {
          const idsDisplay = clearedIds.slice(0, 3).join(', ');
          const suffix = clearedIds.length > 3 ? ' 等会话' : ' 会话';
          messages.push(`已清除关于 ${idsDisplay}${suffix} 的记忆`);
        }
      
        result = messages.join('，');
      }
      
      await session.sendQueued(result);
      return;
    });

  ctx.middleware(async (session: Session, next: Next) => {
    const channelId = session.channelId;
    if (!isChannelAllowed(config.MemorySlot.SlotContains, channelId))
      return next();
    // 检测是否达到发送次数或被 at
    // 返回 false 的条件：
    // 达到触发条数 或者 用户消息提及机器人且随机条件命中。也就是说：
    // 如果触发条数没有达到 (!isTriggerCountReached)
    // 并且消息没有提及机器人或者提及了机器人但随机条件未命中 (!(isAtMentioned && shouldReactToAt))
    // 那么就会执行内部的代码，即跳过这个中间件，不向api发送请求
    const isQueueFull: boolean = await sendQueue.checkQueueSize(channelId);
    const isMixedQueueFull: boolean = await sendQueue.checkMixedQueueSize(channelId);
    const loginStatus = await session.bot.getLogin();
    const isBotOnline = loginStatus.status === 1;
    const atRegex = new RegExp(`<at (id="${session.bot.selfId}".*?|type="all".*?${isBotOnline ? '|type="here"' : ''}).*?/>`);
    const isAtMentioned = atRegex.test(session.content);
    const shouldReactToAt = Random.bool(config.MemorySlot.AtReactPossibility);

    if (isQueueFull || isMixedQueueFull || isAtMentioned && shouldReactToAt || config.Debug.TestMode) {

      const chatHistory = await processContent(config, session,await sendQueue.getMixedQueue(channelId));
      if (config.Debug.DebugAsInfo)
        ctx.logger.info(chatHistory);
      const {current, adapter} = adapterSwitcher.getAdapter();

      if (!adapter) {
        ctx.logger.warn("没有可用的适配器");
        return next();
      }

      if (config.Debug.DebugAsInfo)
        ctx.logger.info(`Request sent, awaiting for response...`);

      const chatResponse = await adapter.generateResponse(
        [
          SystemMessage(await genSysPrompt(config, channelId)),
          AssistantMessage("Resolve OK"),
          UserMessage(chatHistory),
        ],
        config
      );

      if (config.Debug.DebugAsInfo)
        ctx.logger.info(foldText(JSON.stringify(chatResponse, null, 2), 3500));

      let replyTo = (chatResponse.replyTo && chatResponse.replyTo !== '') ? chatResponse.replyTo : session.channelId;
      let botName = await getBotName(config.Bot, session);
      let nextTriggerCount = chatResponse.nextTriggerCount;

      if (chatResponse.status === "fail") {
        const failTemplate = `
LLM 的响应无法正确解析。
原始响应:
${chatResponse.content}
---
消耗: 输入 ${chatResponse?.usage?.prompt_tokens}, 输出 ${chatResponse?.usage?.completion_tokens}`;
        await reportLogicMessage(config, session, failTemplate);
        throw new Error(`LLM provides unexpected response:\n${chatResponse.content}`);
      }

      const template = `
${chatResponse.status === "skip" ? `${botName}想要跳过此次回复` : `回复于 ${replyTo} 的消息已生成，来自 API ${current}:`}
---
内容: ${chatResponse.finalReply && chatResponse.finalReply.trim() ? chatResponse.finalReply : "无"}
---
逻辑: ${chatResponse.logic}
---
指令：${chatResponse.execute?.length ? chatResponse.execute : "无"}
---
距离下次：${nextTriggerCount}
---
消耗: 输入 ${chatResponse?.usage?.prompt_tokens}, 输出 ${chatResponse?.usage?.completion_tokens}`;
      await reportLogicMessage(config, session, template);

      // 如果 AI 使用了指令
      if (chatResponse.execute && chatResponse.execute.length > 0) {
        chatResponse.execute.forEach(async (command) => {
          try {
            await session.bot.sendMessage(replyTo, h("execute", {}, command));
            ctx.logger.info(`已执行指令：${command}`);
          } catch (error) {
            ctx.logger.error(`执行指令<${command.toString()}>时出错: ${error}`);
          }
        });
      }

      if (chatResponse.finalReply && chatResponse.finalReply !== "") {
        if (chatResponse.quote && chatResponse.quote !== "") {
          chatResponse.finalReply = h.quote(chatResponse.quote).toString() + chatResponse.finalReply;
        }
        await session.bot.sendMessage(replyTo, chatResponse.finalReply);
      }
    }
    
  });
}


async function reportLogicMessage(
  config: Config, 
  session: Session,
  message: string,
) {
  if (config.Settings.LogicRedirect.Enabled)
    await session.bot.sendMessage(config.Settings.LogicRedirect.Target, message);
}