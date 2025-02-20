import { AxiosInstance, AxiosHeaders } from "axios";
import { createAxiosInstance } from "../utils/axiosInstance";
import GlobalSetting from "../models/GlobalSetting";
import { GlobalSettingAttributes } from "../models/GlobalSetting";
import * as cheerio from "cheerio";
import { config } from "../config";
import { Logger } from "../utils/logger";

interface sourceItem {
  messageId?: string;
  title?: string;
  completeTitle?: string;
  link?: string;
  pubDate?: string;
  content?: string;
  description?: string;
  image?: string;
  cloudLinks?: string[];
  tags?: string[];
  cloudType?: string;
}

export class Searcher {
  private axiosInstance: AxiosInstance | null = null;

  constructor() {
    this.initializeAxiosInstance();
  }

  private async initializeAxiosInstance(isUpdate = false) {
    let settings = null;
    if (isUpdate) {
      settings = await GlobalSetting.findOne();
    }
    const globalSetting = settings?.dataValues || ({} as GlobalSettingAttributes);
    this.axiosInstance = createAxiosInstance(
      config.telegram.baseUrl,
      AxiosHeaders.from({
        accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
        "accept-language": "zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6",
        "cache-control": "max-age=0",
        priority: "u=0, i",
        "sec-ch-ua": '"Microsoft Edge";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"macOS"',
        "sec-fetch-dest": "document",
        "sec-fetch-mode": "navigate",
        "sec-fetch-site": "none",
        "sec-fetch-user": "?1",
        "upgrade-insecure-requests": "1",
      }),
      globalSetting?.isProxyEnabled,
      globalSetting?.isProxyEnabled
        ? { host: globalSetting?.httpProxyHost, port: globalSetting?.httpProxyPort }
        : undefined
    );
  }
  public async updateAxiosInstance() {
    await this.initializeAxiosInstance(true);
  }

  private extractCloudLinks(text: string): { links: string[]; cloudType: string } {
    const links: string[] = [];
    let cloudType = "";
    Object.values(config.cloudPatterns).forEach((pattern, index) => {
      const matches = text.match(pattern);
      if (matches) {
        links.push(...matches);
        cloudType = Object.keys(config.cloudPatterns)[index];
      }
    });
    return {
      links: [...new Set(links)],
      cloudType,
    };
  }

  async searchAll(keyword: string, channelId?: string, messageId?: string) {
    const allResults = [];
    const totalChannels = config.rss.channels.length;

    const channelList = channelId
      ? config.rss.channels.filter((channel) => channel.id === channelId)
      : config.rss.channels;

    for (let i = 0; i < channelList.length; i++) {
      const channel = channelList[i];
      try {
        const messageIdparams = messageId ? `before=${messageId}` : "";
        const url = `/${channel.id}${keyword ? `?q=${encodeURIComponent(keyword)}&${messageIdparams}` : `?${messageIdparams}`}`;
        console.log(`Searching in channel ${channel.name} with URL: ${url}`);
        const results = await this.searchInWeb(url, channel.id);
        console.log(`Found ${results.items.length} items in channel ${channel.name}`);
        if (results.items.length > 0) {
          const channelResults = results.items
            .filter((item: sourceItem) => item.cloudLinks && item.cloudLinks.length > 0)
            .map((item: sourceItem) => ({
              ...item,
              channel: channel.name,
              channelId: channel.id,
            }));

          allResults.push({
            list: channelResults,
            channelInfo: {
              ...channel,
              channelLogo: results.channelLogo,
            },
            id: channel.id,
          });
        }
      } catch (error) {
        Logger.error(`搜索频道 ${channel.name} 失败:`, error);
      }
    }

    return {
      data: allResults,
    };
  }

  async searchInWeb(url: string, channelId: string) {
    try {
      if (!this.axiosInstance) {
        throw new Error("Axios instance is not initialized");
      }
      const response = await this.axiosInstance.get(url);
      const html = response.data;
      const $ = cheerio.load(html);
      const items: sourceItem[] = [];
      let channelLogo = "";
      $(".tgme_header_link").each((_, element) => {
        channelLogo = $(element).find("img").attr("src") || "";
      });
      // 遍历每个消息容器
      $(".tgme_widget_message_wrap").each((_, element) => {
        const messageEl = $(element);

        // 通过 data-post 属性来获取消息的链接 去除channelId 获得消息id
        const messageId = messageEl
          .find(".tgme_widget_message")
          .data("post")
          ?.toString()
          .split("/")[1];

        // 提取标题 (第一个<br>标签前的内容)
        const title =
          messageEl
            .find(".js-message_text")
            .html()
            ?.split("<br>")[0]
            .replace(/<[^>]+>/g, "")
            .replace(/\n/g, "") || "";

        // 提取描述 (第一个<a>标签前面的内容，不包含标题)
        const content =
          messageEl
            .find(".js-message_text")
            .html()
            ?.replace(title, "")
            .split("<a")[0]
            .replace(/<br>/g, "")
            .trim() || "";

        // 提取链接 (消息中的链接)
        // const link = messageEl.find('.tgme_widget_message').data('post');

        // 提取发布时间
        const pubDate = messageEl.find("time").attr("datetime");

        // 提取图片
        const image = messageEl
          .find(".tgme_widget_message_photo_wrap")
          .attr("style")
          ?.match(/url\('(.+?)'\)/)?.[1];

        const tags: string[] = [];
        // 提取云盘链接
        const links = messageEl
          .find(".tgme_widget_message_text a")
          .map((_, el) => $(el).attr("href"))
          .get();
        messageEl.find(".tgme_widget_message_text a").each((index, element) => {
          const tagText = $(element).text();
          if (tagText && tagText.startsWith("#")) {
            tags.push(tagText);
          }
        });
        const cloudInfo = this.extractCloudLinks(links.join(" "));
        // 添加到数组第一位
        items.unshift({
          messageId,
          title,
          pubDate,
          content,
          image,
          cloudLinks: cloudInfo.links,
          cloudType: cloudInfo.cloudType,
          tags,
        });
      });
      return { items: items, channelLogo };
    } catch (error) {
      Logger.error(`搜索错误: ${url}`, error);
      return {
        items: [],
        channelLogo: "",
      };
    }
  }
}

export default new Searcher();
