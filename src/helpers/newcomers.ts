// Dependencies
import Telegraf, { ContextMessageUpdate, Extra } from 'telegraf'
import { strings } from './strings'
import {
  Candidate,
  findChatsWithCandidates,
  CaptchaType,
  Equation,
} from '../models'
import { bot } from './bot'
import { User } from 'telegram-typings'
import { report } from './report'
import { checkIfErrorDismissable } from './error'
import { ExtraReplyMessage } from 'telegraf/typings/telegram-types'
import { generateEquation } from './equation'

export function setupNewcomers(bot: Telegraf<ContextMessageUpdate>) {
  // Add newcomers
  bot.on('new_chat_members', async ctx => {
    if (ctx.chat.type === 'channel') {
      return
    }
    const chat = ctx.dbchat
    const candidates = chat.candidates
    const candidatesToAdd = [] as Candidate[]
    for (const member of ctx.message.new_chat_members) {
      if (member.username === (bot as any).options.username) {
        ctx.replyWithMarkdown(strings(chat, 'help'), {
          disable_web_page_preview: true,
        })
        continue
      }
      if (member.is_bot) {
        continue
      }
      if (candidates.map(c => c.id).indexOf(member.id) < 0) {
        const equation =
          chat.captchaType === CaptchaType.DIGITS
            ? generateEquation()
            : undefined
        const message = await notifyCandidate(ctx, member, equation)
        candidatesToAdd.push({
          id: member.id,
          timestamp: new Date().getTime(),
          captchaType: chat.captchaType,
          messageId: message.message_id,
          equation,
        })
      }
      // Restrict if requested
      if (chat.restrict) {
        console.log('🤜 Restricting as well')
        try {
          const tomorrow = (new Date().getTime() + 24 * 60 * 60 * 1000) / 1000
          await (ctx.telegram as any).restrictChatMember(chat.id, member.id, {
            until_date: tomorrow,
            can_send_messages: true,
            can_send_media_messages: false,
            can_send_other_messages: false,
            can_add_web_page_previews: false,
          })
        } catch (err) {
          report(bot, err)
        }
      }
    }
    console.log(
      `➕ Adding candidates to ${ctx.chat.id}: ${candidatesToAdd.map(c =>
        c.id ? c.id : c
      )}`
    )
    chat.candidates = candidates.concat(candidatesToAdd)
    // Restrict if requested
    if (chat.restrict) {
      chat.restrictedUsers = chat.restrictedUsers.concat(candidatesToAdd)
    }
    console.log(
      `✅ Resulting candidates of ${ctx.chat.id}: ${chat.candidates.map(v =>
        v.id ? v.id : v
      )}`
    )
    await (chat as any).save()
    // Delete entry message if required
    if (chat.deleteEntryMessages) {
      try {
        await ctx.telegram.deleteMessage(ctx.chat!.id, ctx.message!.message_id)
      } catch (err) {
        report(bot, err)
      }
    }
  })
  // Check newcomers
  bot.use(async (ctx, next) => {
    const chat = ctx.dbchat
    if (!chat.candidates.length) {
      return next()
    }
    if (
      [CaptchaType.SIMPLE, CaptchaType.DIGITS].indexOf(chat.captchaType) < 0
    ) {
      return next()
    }
    const userId = ctx.from.id
    if (chat.candidates.map(c => c.id).indexOf(userId) < 0) {
      return next()
    }
    const candidate = chat.candidates.filter(c => c.id === userId).pop()
    if (
      candidate.captchaType === CaptchaType.DIGITS &&
      (!ctx.message ||
        !ctx.message.text ||
        ctx.message.text.indexOf(candidate.equation.answer as string) < 0 ||
        (ctx.message.text.match(/\d/g) || []).length > 2)
    ) {
      return next()
    } else if (candidate.captchaType === CaptchaType.DIGITS) {
      try {
        await ctx.deleteMessage()
      } catch (err) {
        // Do nothing
      }
    }
    console.log(`🔥 Removing ${userId} from candidates of ${ctx.chat.id}`)
    chat.candidates = chat.candidates.filter(c => c.id !== userId)
    try {
      ctx.dbchat = await (chat as any).save()
    } catch (err) {
      report(bot, err)
    }
    console.log(
      `✅ Resulting candidates of ${ctx.chat.id}: ${chat.candidates.map(v =>
        v.id ? v.id : v
      )}`
    )
    try {
      await ctx.telegram.deleteMessage(ctx.chat!.id, candidate.messageId)
      if (chat.greetsUsers && chat.greetingMessage) {
        const text = chat.greetingMessage.message.text
        if (text.includes('$username') || text.includes('$title')) {
          await ctx.telegram.sendMessage(
            chat.id,
            text
              .replace(/\$username/g, getUsername(ctx.from))
              .replace(/\$title/g, (await ctx.getChat()).title),
            Extra.webPreview(false) as ExtraReplyMessage
          )
        } else {
          await ctx.telegram.sendCopy(
            chat.id,
            chat.greetingMessage.message,
            Extra.webPreview(false) as ExtraReplyMessage
          )
        }
      }
    } catch (err) {
      report(bot, err)
    }
    next()
  })
  // Check button
  bot.action(/\d+~\d+/, async ctx => {
    console.log(
      `👻 Received callback query: ${ctx.chat.id}, ${ctx.callbackQuery.data}`
    )
    const params = ctx.callbackQuery.data.split('~')
    const userId = parseInt(params[1])
    const chat = ctx.dbchat
    if (userId !== ctx.from.id) {
      return ctx.answerCbQuery(strings(chat, 'only_candidate_can_reply'))
    }
    if (chat.candidates.map(c => c.id).indexOf(userId) < 0) {
      return
    }
    console.log(`🔥 Removing ${userId} from candidates of ${ctx.chat.id}`)
    const candidate = chat.candidates.filter(c => c.id === userId).pop()
    chat.candidates = chat.candidates.filter(c => c.id !== userId)
    try {
      await (chat as any).save()
    } catch (err) {
      report(bot, err)
    }
    console.log(
      `✅ Resulting candidates of ${ctx.chat.id}: ${chat.candidates.map(v =>
        v.id ? v.id : v
      )}`
    )
    try {
      await ctx.telegram.deleteMessage(ctx.chat!.id, candidate.messageId)
      if (chat.greetsUsers && chat.greetingMessage) {
        const text = chat.greetingMessage.message.text
        if (text.includes('$username') || text.includes('$title')) {
          await ctx.telegram.sendMessage(
            chat.id,
            text
              .replace(/\$username/g, getUsername(ctx.from))
              .replace(/\$title/g, (await ctx.getChat()).title),
            Extra.webPreview(false) as ExtraReplyMessage
          )
        } else {
          const message = chat.greetingMessage.message
          message.text = `${message.text}\n\n${getUsername(ctx.from)}`
          await ctx.telegram.sendCopy(chat.id, message, Extra.webPreview(
            false
          ) as ExtraReplyMessage)
        }
      }
    } catch (err) {
      report(bot, err)
    }
  })
}

function notifyCandidate(
  ctx: ContextMessageUpdate,
  candidate: User,
  equation: Equation
) {
  const chat = ctx.dbchat
  const warningMessage = strings(chat, `${chat.captchaType}_warning`)
  const extra =
    chat.captchaType !== CaptchaType.BUTTON
      ? undefined
      : Extra.markup(m =>
          m.inlineKeyboard([
            m.callbackButton(
              strings(chat, 'captcha_button'),
              `${chat.id}~${candidate.id}`
            ),
          ])
        )
  return ctx.replyWithMarkdown(
    `${
      chat.captchaType === CaptchaType.DIGITS ? `(${equation.question}) ` : ''
    }[${getUsername(candidate)}](tg://user?id=${
      candidate.id
    })${warningMessage} (${chat.timeGiven} ${strings(chat, 'seconds')})`,
    extra
  )
}

// Check if needs to ban
setInterval(async () => {
  if (!checking) {
    check()
  }
}, 15 * 1000)

let checking = false
async function check() {
  console.log('🤔 Checking candidates...')
  checking = true
  try {
    const chats = await findChatsWithCandidates()
    console.log(`🙌 Got ${chats.length} chats with candidates`)
    for (const chat of chats) {
      console.log(`🤖 Working on ${chat.id}`)
      const candidatesToDelete = []
      for (const candidate of chat.candidates) {
        const now = new Date().getTime()
        if (now - candidate.timestamp < chat.timeGiven * 1000) {
          console.log(
            `❌ Not kicking ${candidate.id} (${now -
              candidate.timestamp}/${chat.timeGiven * 1000})`
          )
          continue
        }
        try {
          console.log(`💀 Kicking ${candidate.id}`)
          await (bot.telegram as any).kickChatMember(
            chat.id,
            candidate.id,
            parseInt(`${new Date().getTime() / 1000 + 45}`)
          )
          candidatesToDelete.push(candidate)
        } catch (err) {
          if (checkIfErrorDismissable(err)) {
            candidatesToDelete.push(candidate)
          } else {
            report(bot, err)
          }
        }
        try {
          await bot.telegram.deleteMessage(chat.id, candidate.messageId)
        } catch (err) {
          report(bot, err)
        }
      }
      const idsToDelete = candidatesToDelete.map(c => c.id)
      if (idsToDelete.length) {
        console.log(`🔥 Removing ${idsToDelete}`)
        chat.candidates = chat.candidates.filter(
          c => idsToDelete.indexOf(c.id) < 0
        )
        console.log(`✅ Resulting ids: ${chat.candidates}`)
        await chat.save()
      }
      // Check restrictions
      const restrictedToDelete = []
      for (const candidate of chat.restrictedUsers) {
        if (new Date().getTime() - candidate.timestamp > 24 * 60 * 60 * 1000) {
          restrictedToDelete.push(candidate)
        }
      }
      const restrictedIdsToDelete = restrictedToDelete.map(c => c.id)
      if (restrictedIdsToDelete.length) {
        console.log(`🔥 Removing from restrictions ${restrictedIdsToDelete}`)
        chat.restrictedUsers = chat.restrictedUsers.filter(
          c => restrictedIdsToDelete.indexOf(c.id) < 0
        )
        console.log(`✅ Resulting restricted ids: ${chat.restrictedUsers}`)
        await chat.save()
      }
    }
  } catch (err) {
    report(bot, err)
  } finally {
    checking = false
  }
}

function getUsername(user: User) {
  return `${
    user.username
      ? `@${user.username}`
      : `${user.first_name}${user.last_name ? ` ${user.last_name}` : ''}`
  }`
}
