import { Route } from '@/types';
import { load } from 'cheerio';
import { parseDate } from '@/utils/parse-date';
import QueryString from 'node:querystring';
import logger from '@/utils/logger';
import { default as puppeteer, Page } from 'puppeteer';
import { Cluster } from 'puppeteer-cluster';
import { config } from '@/config';
import proxy from '@/utils/proxy';
import proxyChain from 'proxy-chain';

import { PuppeteerExtra, addExtra } from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
export const route: Route = {
    path: '/web/geek/job',
    categories: ['live'],
    example: '/web/geek/job?city=101270100&degree=202&position=100901',
    features: {
        requireConfig: false,
        requirePuppeteer: true,
        antiCrawler: true,
        supportBT: false,
        supportPodcast: false,
        supportScihub: false,
    },
    name: '工作订阅',
    maintainers: ['kkxxdd'],
    handler,
    description: ``,
};

/** *********************************************
 * url_prefix?[query] 参数表转字符串
 * @param query - ctx.req.query() 返回的对象
 */ // -------------------------
function query2string(query) {
    return QueryString.stringify(query, '&', '=', {
        encodeURIComponent: (str) => {
            if (str === ',') {
                return str;
            }
            return QueryString.unescape(str);
        },
    });
}
/** ***************************************************
 *  api data 转换为 job info 的 table
 * @param {JSONObject} json 原始 json 数据
 * @param {Object} extraData 每个元素额外的公共属性
 */ // -------------------------------------------------
function json2jobList(json: JSONObject, extraData?: object) {
    const _jobList = json?.zpData?.jobList;
    const jobList: Array<any> = [];
    for (const [index, item] of _jobList.entries()) {
        jobList[index] = {
            title: `${item.jobName} | ${item.salaryDesc} | ${item.jobLabels}`,
            author: `${item.brandName} / ${item.areaDistrict} ${item.businessDistrict} / ${item.brandScaleName} / ${item.brandStageName}`,
            link: `https://www.zhipin.com/job_detail/${item.encryptJobId}.html?lid=${item.lid}&securityId=${item.securityId}&sessionId=`,
            pubDate: parseDate(Date.now()),
            guid: item.securityId,
            itunes_item_image: item.brandLogo,
            ...extraData,
            // category: queryParams.position, // TODO: - 类别代码转为类别名称
        };
    }
    return jobList;
}
/** *******************************************
 * 从搜索页面的 .job-list-box li 元素中获取岗位信息
 * @param {Page} page pupeteer 的 page 对象
 * @return  Promise{joblist}
 */ // -----------------------------
async function page2JobList(page: Page) {
    // 没有进入正常页面时，返回空数组
    if ((await page.$('.error-content')) || (await page.$('.wrap-verify-slider'))) {
        return [];
    }
    // NOTE: 这个太细节了，这里不仅等待的式列表元素渲染，而且是等到最后一个列表项内部渲染完毕
    await page.waitForSelector('ul.job-list-box li.job-card-wrapper:last-child div.job-title.clearfix').catch((error) => {
        logger.warn('等待页面关键元素渲染超时：' + error);
        return [];
    });
    const jobList: any[] = [];
    const p_$jobList = await page.$$('ul.job-list-box li.job-card-wrapper');
    // #wrap > div.page-job-wrapper > div.page-job-inner > div > div.job-list-wrapper > div.search-job-result > ul.job-list-box > li:nth-child(1) > div.job-card-body.clearfix > a > div.job-title.clearfix
    const p_$jobTitles = await page.$$('ul.job-list-box li.job-card-wrapper div.job-title.clearfix');
    // NOTE: 触发 .job-title.clearfix 元素 mouseenter 事件，激活 .job-detail-card 悬浮窗
    await Promise.all(
        p_$jobTitles.map(async (p_$title, index) => {
            await p_$title.evaluate((ele) => {
                const mouseEnterEvent = new MouseEvent('mouseenter', {
                    bubbles: true,
                    cancelable: true,
                    view: window,
                });
                ele.dispatchEvent(mouseEnterEvent);
            });
            await p_$jobList[index].waitForSelector('.job-detail-card').catch(() => {
                logger.warn('detail 弹窗触发失败');
                return;
            });
            return;
        })
    );

    const response = await page.content();
    const $ = load(response);
    const $jobList = $('ul.job-list-box').children('li.job-card-wrapper');
    $jobList.map((index, item) => {
        const jobInfo = {
            title: $(item).find('.job-name')?.text(), // 工作标题
            job_area: $(item).find('.job-area')?.text(), // 工作地点
            salary: $(item).find('.salary')?.text(), //
            experience: $(item).find('.job-info>ul>li')?.text(),
            education: $(item).find('.job-info>ul>li:nth-child(2)')?.text(),
            company_name: $(item).find('.company-info .company-name a')?.text(),
            company_url: $(item).find('.company-info .company-name a')?.attr('href'),
            industry: $(item).find('.job-card-footer>ul>li')?.text(),
            skill: $(item).find('.job-card-footer>ul>li:nth-child(2)')?.text(),
            desc: $(item).find('.job-card-footer .info-desc')?.text(),
            link: $(item).find('.job-card-body>a')?.attr('href'),
            company_logo: $(item).find('.job-car-right .company-logo>a>img')?.attr('src'),
            detail: $(item).find('.job-detail-card')?.html(),
        };

        // const p_$jobDetail = await p_$jobList?.[index].waitForSelector('.job-detail-card');
        // const detail_innerHTML = await p_$jobDetail?.evaluate((ele) => ele.innerHTML);
        // const $detail = load(detail_innerHTML || '');
        if (jobInfo.detail === '') {
            // XXX: 没有成功激活 detail 悬浮窗
            logger.warn(page.url() + ' li:' + index + ';无法获取 detail 弹窗');
            jobList.push({
                link: jobInfo.link,
                description: $(item).toString,
            });
        } else {
            jobList.push({
                link: jobInfo.link,
                description: $(item).toString() + (jobInfo?.detail ?? ''),
            });
        }

        return;
    });
    return jobList;
}

// Function to handle proxy and stealth mode
async function customPuppeteer(stealth: boolean = false) {
    let insidePuppeteer: PuppeteerExtra | typeof puppeteer = puppeteer;

    // Add stealth plugin if required
    if (stealth) {
        insidePuppeteer = addExtra(puppeteer);
        insidePuppeteer.use(StealthPlugin());
    }
    // Define the Puppeteer options
    const puppeteerOptions = {
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-infobars', '--window-position=0,0', '--ignore-certificate-errors', '--ignore-certificate-errors-spki-list', `--user-agent=${config.ua}`],
        headless: true,
        ignoreHTTPSErrors: true,
        executablePath: config.chromiumExecutablePath || undefined,
    };
    if (proxy.proxyUri) {
        if (proxy.proxyUrlHandler?.username || proxy.proxyUrlHandler?.password) {
            if (proxy.proxyUrlHandler.protocol === 'http:') {
                puppeteerOptions.args.push(`--proxy-server=${await proxyChain.anonymizeProxy(proxy.proxyUri)}`);
            } else {
                logger.warn('SOCKS/HTTPS proxy with authentication is not supported by Puppeteer, continuing without proxy.');
            }
        } else {
            puppeteerOptions.args.push(`--proxy-server=${proxy.proxyUri.replace('socks5h://', 'socks5://').replace('socks4a://', 'socks4://')}`);
        }
    }

    return {
        puppeteer: insidePuppeteer,
        option: puppeteerOptions,
    };
}
/** ********************************
 * @description 使用 puppeteer-cluster 异步并发的获取多个目标页面的 joblist
 * @param targetURLs 目标网址的数组
 * @param maxConcurrency 最大页面数
 * @return jobList
 */ // -----------------------------
async function getJobs(targetURLs: Array<string>, maxConcurrency: number = 3) {
    const jobList_json: any[] = [];
    const jobList_page: any[] = [];
    const jobList_final: any[] = [];

    const myPuppeteer = await customPuppeteer();
    const cluster = await Cluster.launch({
        concurrency: Cluster.CONCURRENCY_CONTEXT,
        maxConcurrency, // Use maxConcurrency as passed or defined elsewhere
        puppeteer: myPuppeteer.puppeteer, // Pass the custom Puppeteer module
        puppeteerOptions: myPuppeteer.option, // Pass the Puppeteer launch options
        monitor: true, // Enable monitoring
        retryLimit: 0, // Set the retry limit to 0
        workerCreationDelay: 2000, // Delay between creating workers
    });

    cluster.on('taskerror', (err, data, willRetry) => {
        if (willRetry) {
            logger.warn(`Encountered an error while crawling ${data}. ${err.message}\nThis job will be retried`);
        } else {
            logger.error(`Failed to crawl ${data}: ${err.message}`);
        }
    });
    // XXX: ip限制页面时的可能无法处理
    await cluster.task(async ({ page, data: url }) => {
        page.on('response', async (res) => {
            if (res.ok() && res.url().includes('joblist.json?scene') && res.headers()['content-type'] === 'application/json') {
                const data = await res.buffer().catch((error) => {
                    logger.error('Error retrieving response buffer:', {
                        message: error.message,
                        stack: error.stack,
                        status: res.status(),
                        url: res.url(),
                    });
                });
                if (Buffer.isBuffer(data)) {
                    const str = data.toString('utf8');
                    const resJson = JSON.parse(str);
                    jobList_json.push(...json2jobList(resJson));
                } else if (typeof data === 'string') {
                    const resJson = JSON.parse(data);
                    logger.info(resJson);
                }
            } else if (300 < res.status() && res.status() < 400) {
                if (res.url().includes('user/safe/verify-slider') || res.url().includes('icon-page-error.png')) {
                    logger.warn('重定向到验证页面: ' + res.url());
                } else {
                    logger.warn('触发了重定向: ' + res.url());
                }
            }
        });
        page.goto(url, {
            waitUntil: 'networkidle0',
        });
        logger.http(`Requesting ${url}`);

        await page.waitForNavigation({ waitUntil: 'networkidle0' });

        jobList_page.push(...(await page2JobList(page)));

        if (jobList_page.length === jobList_json.length && jobList_page.length > 0 && jobList_page.length > 0) {
            logger.info('共获取' + jobList_json.length + '条数据');
            jobList_final.push(...jobList_json.map((item, index) => Object.assign(item, jobList_page[index])));
        } else if (jobList_page.length !== jobList_json.length) {
            logger.warn('捕获的api返回数据和页面列表个数不一致');
            jobList_final.push({
                title: '未获取到数据',
            });
        } else if (jobList_json.length === 0 || jobList_page.length === 0) {
            logger.warn('未获取到数据');
            jobList_final.push({
                title: '未获取到数据',
            });
        }
    });

    targetURLs.map((url) => cluster.queue(url));

    await cluster.idle();
    await cluster.close();
    return jobList_final;
}

async function handler(ctx) {
    const queryParams = ctx.req.query(); // url 查询字段对象
    // const position = queryParams.position.split(','); // 工作所在行业类目代码
    const queryString = query2string(queryParams); // url 查询字段对象转字符串
    const basePath = `https://www.zhipin.com/web/geek/job?`; // 基础 url
    const targetURLs: any[] = []; // 目标页面，自动生成
    const pageIndexStart = queryParams?.page || 1; // 当前页面所在页数
    const pageIndexTatal = 3; // 从当前页数向后访问的页面数量
    for (let i = 0; i < pageIndexTatal; i++) {
        // 进入第一页时，不传入 page=1 查询字段也许更利于反爬
        if (i === 1) {
            queryParams.page = null;
            targetURLs.push(`${basePath}${query2string(queryParams)}`);
        } else {
            targetURLs.push(`${basePath}${query2string(queryParams)}`);
        }
        queryParams.page = pageIndexStart + i;
    }
    const jobList = await getJobs(targetURLs, 1);

    return {
        description: `Boss 直聘 —— ${queryString}`,
        item: jobList,
        title: `Boss 直聘工作订阅`,
        link: 'www.zhipin.com',
        image: 'https://www.zhipin.com/favicon.ico',
        logo: 'https://www.zhipin.com/favicon.ico',
        icon: 'https://www.zhipin.com/favicon.ico',
    };
}
