import {
    extension_settings,
    getContext,
  } from "../../../extensions.js";

import { saveSettingsDebounced,
    setEditedMessageId,
    generateQuietPrompt,
    is_send_press,
    substituteParamsExtended,
 } from "../../../../script.js";

 import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
 import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
 import { getMessageTimeStamp } from '../../../RossAscends-mods.js';
 import { MacrosParser } from '../../../macros.js';
 import { is_group_generating, selected_group } from '../../../group-chats.js';

const extensionName = "sillytavern-autoResp";
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;
const defaultSettings = {
    enabled: false,
    llm_prompt: `请立即停止当前的角色扮演，并提供一个回复，包含 {{suggestionNumber}} 个简短、独特的单句建议，用于推动故事的下一个节点，从 {{user}} 的视角出发。
    每个建议应符合以下描述之一：
1. 缓解紧张局势，改善主角的处境。
2. 制造或增加紧张局势，恶化主角的处境。
3. 直接但合理地引导故事走向一个出人意料的转折或非常奇特的事件。
4. 缓慢地推动故事发展，不结束当前场景。
5. 推动故事前进，如果合适，可以结束当前场景。

请确保每个建议都被 <suggestion> 标签包围，例如：
<suggestion>建议1</suggestion>
<suggestion>建议2</suggestion>
...

回复中不应包含其他内容。`,
    llm_prompt_impersonate: `[从 {{user}} 的视角，为下一个故事节点设定事件方向：{{suggestionText}}]
[依据上述事件方向，撰写用户的回应]`,
    apply_wi_an: true,
    num_responses: 5,
    response_length: 500,
};

let inApiCall = false;

/**
 * Removes the last autoResp message from the chat
 * @param {getContext.chat} chat
 */
function removeLastAutoRespMessage(chat = getContext().chat) {
    let lastMessage = chat[chat.length - 1];
    if (!lastMessage?.extra || lastMessage?.extra?.model !== 'autoResp') {
        return;
    }

    // 使用 jQuery 选择器找到最后一条消息的 DOM 元素
    const target = $('#chat').find(`.mes[mesid=${lastMessage.mesId}]`);
    if (target.length === 0) {
        return;
    }

    // 设置编辑消息的 ID
    // 这行代码的作用是将最后一条消息的ID设置为当前正在操作的消息ID。这样做的目的是在触发删除操作时，能够记录下这条消息的ID，以便在需要时可以进行进一步的处理。
    setEditedMessageId(lastMessage.mesId);

    // 在找到的 DOM 元素中，找到类为 .mes_edit_delete 的元素，并触发点击事件。
    // 传递一个对象 { fromSlashCommand: true } 作为事件的额外参数，表示该点击事件是由斜杠命令触发的。
    target.find('.mes_edit_delete').trigger('click', { fromSlashCommand: true });
}


/**
 * Parses the autoResp response and returns the suggestions buttons
 * @param {string} response
 * @returns {string} text
 */
function parseResponse(response) {
    const suggestions = [];
    const regex = /<suggestion>(.+?)<\/suggestion>|Suggestion\s+\d+\s*:\s*(.+)|Suggestion_\d+\s*:\s*(.+)|^\d+\.\s*(.+)/gim;
    let match;

    while ((match = regex.exec(`${response}\n`)) !== null) {
        const suggestion = match[1] || match[2] || match[3] || match[4];
        if (suggestion && suggestion.trim()) {
            suggestions.push(suggestion.trim());
        }
    }

    if (suggestions.length === 0) {
        return;
    }

    const newResponse = suggestions.map((suggestion) =>
`<div class="suggestion"><button class="suggestion">${suggestion}</button><button class="edit-suggestion fa-solid fa-pen-to-square"><span class="text">${suggestion}</span></button></div>`);
    return `<div class=\"suggestions\">${newResponse.join("")}</div>`
}

async function waitForGeneration() {
    try {
        // Wait for group to finish generating
        if (selected_group) {
            await waitUntilCondition(() => is_group_generating === false, 1000, 10);
        }
        // Wait for the send button to be released
        waitUntilCondition(() => is_send_press === false, 30000, 100);
    } catch {
        console.debug('Timeout waiting for is_send_press');
        return;
    }
}
/**
 * Handles the autoResp response generation
 * @returns
 */
async function requestAutoRespResponses() {
    const context = getContext();
    const chat = context.chat;

    // no characters or group selected
    if (!context.groupId && context.characterId === undefined) {
        return;
    }

    // Currently summarizing or frozen state - skip
    if (inApiCall) {
        return;
    }

    // No new messages - do nothing
    // if (chat.length === 0 || (lastMessageId === chat.length && getStringHash(chat[chat.length - 1].mes) === lastMessageHash)) {
    if (chat.length === 0) {
        return;
    }

    // removeLastautoRespMessage(chat);

    await waitForGeneration();

    toastr.info('autoResp: Generating response...');
    const prompt = extension_settings.autoResp_responses?.llm_prompt || defaultSettings.llm_prompt || "";
    const useWIAN = extension_settings.autoResp_responses?.apply_wi_an || defaultSettings.apply_wi_an;
    const responseLength = extension_settings.autoResp_responses?.response_length || defaultSettings.response_length;
    //  generateQuietPrompt(quiet_prompt, quietToLoud, skipWIAN, quietImage = null, quietName = null, responseLength = null, noContext = false)
    const response = await generateQuietPrompt(prompt, false, !useWIAN, null, "Suggestion List", responseLength);

    const parsedResponse = parseResponse(response);
    if (!parsedResponse) {
        toastr.error('autoResp: Failed to parse response');
        return;
    }

    await sendMessageToUI(parsedResponse);
}



/**
 * Sends the parsed autoResp response to the SillyTavern UI
 * @param {string} parsedResponse
 */
async function sendMessageToUI(parsedResponse) {
    const context = getContext();
    const chat = context.chat;

    const messageObject = {
        name: "autoResp Suggestions",
        is_user: true,
        is_system: false,
        send_date: getMessageTimeStamp(),
        mes: `${parsedResponse}`,
        mesId: context.chat.length,
        extra: {
            api: 'manual',
            model: 'autoResp',
        }
    };

    context.chat.push(messageObject);
    // await eventSource.emit(event_types.MESSAGE_SENT, (chat.length - 1));
    context.addOneMessage(messageObject, { showSwipes: false, forceId: chat.length - 1 });
}

/**
 * Handles the resp click event by doing impersonation
 * @param {*} event
 */
async function handleRespBtn(event) {
    // 获取点击的按钮元素  
    const $button = $(event.target);

    // 获取按钮文本，优先获取按钮自身的文本，如果为空则获取子元素 .custom-text 的文本
    const text = $button?.text()?.trim() || $button.find('.custom-text')?.text()?.trim();
    if (text.length === 0) {
        return;
    }

    // 等待生成操作完成
    // Wait for the send button to be released
    await waitForGeneration();

    // 移除最后一条autoResp消息
    removeLastAutoRespMessage();

    // Sleep for 500ms before continuing
    await new Promise(resolve => setTimeout(resolve, 250));

    
    // 获取输入文本框元素
    // 如果输入框不存在或不是一个文本框，直接返回
    const inputTextarea = document.querySelector('#send_textarea');
    if (!(inputTextarea instanceof HTMLTextAreaElement)) {
        return;
    }

    // 获取模拟提示的模板
    // 替换模板中的占位符，插入按钮文本
    let impersonatePrompt = extension_settings.autoResp_responses?.llm_prompt_impersonate || '';
    impersonatePrompt = substituteParamsExtended(String(extension_settings.autoResp_responses?.llm_prompt_impersonate), { suggestionText: text });

    // 构建静默提示命令
    // 将构建的提示命令设置到输入框中
    const quiet_prompt = `/impersonate await=true ${impersonatePrompt}`;
    inputTextarea.value = quiet_prompt;

    // 如果按钮是自定义编辑建议按钮，直接返回
    if ($button.hasClass('custom-edit-suggestion')) {
        return; // Stop here if it's the edit button
    }

    // 触发输入框的 input 事件
    inputTextarea.dispatchEvent(new Event('input', { bubbles: true }));

    // 获取发送按钮元素
    const sendButton = document.querySelector('#send_but');
    if (sendButton instanceof HTMLElement) {
        sendButton.click();
    }
}

/**
 * Handles the CYOA by sending the text to the User Input box
 * @param {*} event
 */
// function handleCYOAEditBtn(event) {
//     const $button = $(event.target);
//     const text = $button.find('.custom-text').text().trim();
//     if (text.length === 0) {
//         return;
//     }

//     removeLastCYOAMessage();
//     const inputTextarea = document.querySelector('#send_textarea');
//     if (inputTextarea instanceof HTMLTextAreaElement) {
//         inputTextarea.value = text;
//     }
// }


/**
 * Settings Stuff
 */
function loadSettings() {

    // 确保 extension_settings.autoResp_responses 存在，如果不存在则初始化为空对象
    extension_settings.autoResp_responses = extension_settings.autoResp_responses || {};
    /*if (Object.keys(extension_settings.autoResp_responses).length === 0) {
        extension_settings.autoResp_responses = {};
    }*/

    // 将 extension_settings.autoResp_responses 的内容合并到 defaultSettings 对象中
    Object.assign(defaultSettings, extension_settings.autoResp_responses);


    //这部分代码使用jQuery选择器选择页面上ID为 _llm_prompt 的元素。通常，这个元素是一个输入框（<input> 或 <textarea>）。
    //这部分代码使用jQuery的 .val() 方法设置输入框的值。extension_settings._responses.llm_prompt 是从某个设置对象中获取的值，这个值将被设置到输入框中。
    //这部分代码使用jQuery的 .trigger() 方法触发 input 事件。input 事件在输入框的值发生变化时被触发，这可以通知任何绑定到该事件的处理函数，输入框的值已经更新。

    $('#autoResp_llm_prompt').val(extension_settings.autoResp_responses.llm_prompt).trigger('input');
    $('#autoResp_llm_prompt_impersonate').val(extension_settings.autoResp_responses.llm_prompt_impersonate).trigger('input');
    $('#autoResp_apply_wi_an').prop('checked', extension_settings.autoResp_responses.apply_wi_an).trigger('input');
    $('#autoResp_num_responses').val(extension_settings.autoResp_responses.num_responses).trigger('input');
    $('#autoResp_num_responses_value').text(extension_settings.autoResp_responses.num_responses);
    $('#autoResp_response_length').val(extension_settings.autoResp_responses.response_length).trigger('input');
    $('#autoResp_response_length_value').text(extension_settings.autoResp_responses.response_length);

}

function addEventListeners() {
    $('#autoResp_llm_prompt').on('input', function() {
        extension_settings.autoResp_responses.llm_prompt = $(this).val();
        saveSettingsDebounced();
    });

    $('#autoResp_llm_prompt_impersonate').on('input', function() {
        extension_settings.autoResp_responses.llm_prompt_impersonate = $(this).val();
        saveSettingsDebounced();
    });

    $('#autoResp_apply_wi_an').on('change', function() {
        extension_settings.autoResp_responses.apply_wi_an = !!$(this).prop('checked');
        saveSettingsDebounced();
    });
    $('#autoResp_num_responses').on('input', function() {
        const value = $(this).val();
        extension_settings.autoResp_responses.num_responses = Number(value);
        $('#autoResp_num_responses_value').text(value);
        saveSettingsDebounced();
    });

    $('#autoResp_response_length').on('input', function() {
        const value = $(this).val();
        extension_settings.autoResp_responses.response_length = Number(value);
        $('#autoResp_response_length_value').text(value);
        saveSettingsDebounced();
    });
}


//在魔法棒栏目里加一个按钮。
function createButton() {
    const menu = document.getElementById('extensionsMenu');

     // 设置按钮的ID为“autoResp”
     // 设置按钮的类型。
    const extensionButton = document.createElement('div');
    extensionButton.id = 'autoResp'; 
    extensionButton.classList.add('list-group-item', 'flex-container', 'flexGap5', 'interactable');
    extensionButton.tabIndex = 0;

    //设置按钮的图标
    const autoResp_icon = document.createElement('i');
    autoResp_icon.classList.add('fa-regular', 'fa-message');

    //设置按钮的文字
    const text = document.createElement('span');
    text.innerText = 'autoResp';
    extensionButton.appendChild(autoResp_icon);
    extensionButton.appendChild(text);

    //监听按钮点击动作
    extensionButton.onclick = handleClick;

    async function handleClick() {
        //点击图标生成提示词。
        //let pic_promt = await   requestAutoRespResponses();
        await   requestAutoRespResponses();

        return; 
    }

    if (!menu) {
        console.warn('createButton: menu not found');
        return extensionButton;
    }

    menu.appendChild(extensionButton);
    return extensionButton;
}


// This function is called when the extension is loaded
jQuery(async () => {
    //add a delay to possibly fix some conflicts
    await new Promise(resolve => setTimeout(resolve, 900));
    const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);
    $("#extensions_settings").append(settingsHtml);
    loadSettings();
    addEventListeners();
    /*SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'cyoa',
        callback: async () => {
            await requestCYOAResponses();
            return '';
        },
        helpString: 'Triggers CYOA responses generation.',
    }));
    */

    //不使用斜线命令，改成增加一个按钮。

    //注册宏
    MacrosParser.registerMacro('suggestionNumber', () => `${extension_settings.autoResp_responses?.num_responses || defaultSettings.num_responses}`);


    //在UI界面上 创建 AutoResp 按钮, 并且监听按钮点击事件。
    createButton();

    // Event delegation for autoResp buttons
    $(document).on('click', 'button.custom-edit-suggestion', handleRespBtn);
    $(document).on('click', 'button.custom-suggestion', handleRespBtn);
});
