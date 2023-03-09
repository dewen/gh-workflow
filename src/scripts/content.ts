import git from 'isomorphic-git';
import http from 'isomorphic-git/http/node';
import axios, { AxiosResponse } from 'axios';
import yargs from 'yargs';
import * as fs from 'fs';
import * as os from 'os';
import { resolve } from 'path';
import { v4 as uuid } from 'uuid';
import { execSync } from 'child_process';

type ContentCommitProps = {
  base: string;
  script: string;
  message: string;
  path: string;
  gitUrl: string;
  gitUsername: string;
  gitPassword: string;
  tempPath: string;
};

const DEFAULT_BASE_BRANCH = 'main';

const getTempPath = async () => fs.promises.realpath(os.tmpdir());

// @todo: unittest
const getGitWebUrl = (url: string) => {
  if (/^https:\/\/(.+)(\.git)?$/i.test(url)) {
    return url;
  }
  const match = url.match(/^git@(.+):(.+)\.git$/);
  if (!match) {
    throw new Error(`Invalid git url: ${url}`);
  }
  return `https://${match[1]}/${match[2]}.git`;
};
const getRepoInfo = (url: string): {
  owner: string;
  repo: string;
} => {
  const gitMatch = url.match(/^git@(.+):(.+)\.git$/);
  if (!gitMatch) {
    const httpsMatch = url.match(/^https:\/\/([^\/]+)\/([^\/]+)\/([^\.]+)(\.git)?$/i);
    if (!httpsMatch) {
      throw new Error(`Invalid git url: ${url}`);
    }
    return {
      owner: httpsMatch[2],
      repo: httpsMatch[3],
    }
  }
  return {
    owner: gitMatch[2],
    repo: gitMatch[3],
  }
};


const getGitCredentials = () => ({
  username: process.env.CONTENT_PUBLISH_GIT_USERNAME || '',
  password: process.env.CONTENT_PUBLISH_GIT_PASSWORD || '',
});

const validateInput = async (props: ContentCommitProps) => {
  const {
    base,
    script,
    gitUrl: url,
    gitUsername,
    gitPassword,
    tempPath,
  } = props;

  if (!base) {
    throw new Error('Missing "base" branch name.');
  }
  if (!url) {
    throw new Error('Missing repo "url".');
  }
  if (!gitUsername) {
    throw new Error('Missing git "CONTENT_PUBLISH_GIT_USERNAME" from env variable.');
  }
  if (!gitPassword) {
    throw new Error('Missing git "CONTENT_PUBLISH_GIT_PASSWORD" from env variable.');
  }

  if (!script) {
    throw new Error('Missing content update "script".');
  }

  const refs = await git.listServerRefs({
    http,
    url,
    prefix: 'refs/heads/',
    onAuth: () => ({
      username: gitUsername,
      password: gitPassword,
    }),
  });

  const baseRef = refs.find((r) => r.ref.replace('refs/heads/', '') === base);

  if (!baseRef) {
    throw new Error(`Base branch name: ${base} does not exist.`);
  }
  if (!tempPath) {
    throw new Error('Missing "tempPath".');
  }
  if (!fs.existsSync(tempPath)) {
    throw new Error(`Temp path: ${tempPath} does not exist.`);
  }

  try {
    fs.accessSync(tempPath, fs.constants.W_OK);
  } catch (err) {
    throw new Error(`Temp path: ${tempPath} is not writable.`);
  }

  return true;
};

// Commit content updates from a temp checkout.
const contentCommit = async (props: ContentCommitProps): Promise<void> => {
  const {
    base,
    script,
    path: contentPath$,
    message: commitMessage,
    gitUrl,
    gitUsername,
    gitPassword,
    tempPath,
  } = props;
  try {
    const prefix = process.env.CONTENT_PUBLISH_TEMP_PATH_PREFIX || '';
    const authorName = process.env.CONTENT_PUBLISH_AUTHOR_NAME || 'john';
    const authorEmail = process.env.CONTENT_PUBLISH_AUTHOR_EMAIL || 'john@example.com';
    const workingPath = resolve(tempPath, `${prefix}${uuid()}`);
    const {
      owner,
      repo,
    } = getRepoInfo(gitUrl);

    await git.clone({
      fs,
      http,
      dir: workingPath,
      url: gitUrl,
      singleBranch: true,
      onAuth: () => ({
        username: gitUsername,
        password: gitPassword,
      }),
      depth: 1,
    });
    console.log(`Cloned ${gitUrl} to ${workingPath}`);

    const date = new Date();
    const dateName = `${date.getFullYear()}${(date.getMonth() + 1)
      .toString()
      .padStart(2, '0')}${date.getDate().toString().padStart(2, '0')}`;
    const dateStamp = date.valueOf();
    const contentPublishBranch = `content-publish-${dateName}-${dateStamp}`;
    await git.branch({
      fs,
      dir: workingPath,
      ref: contentPublishBranch,
      checkout: true,
    });
    console.log('Checkout branch: ', contentPublishBranch);

    const cmd = `npm i && npm run build && ${script}`;
    try {
      console.log(`Starting - npm run setup && npm run build && ${script}`);
      execSync(cmd, {
        cwd: workingPath,
        encoding: 'utf8',
        stdio: 'pipe',
      });
      console.log('npm run setup && npm run build completed');
    } catch (execError) {
      throw new Error(`Setup and build error: ${execError.stderr}`);
    }

    // find modified files.
    // ref: https://isomorphic-git.org/docs/en/statusMatrix.html
    enum StatusEnum {
      FILE,
      HEAD,
      WORKDIR,
      STAGE,
    }

    // const contentPath = resolve(workingPath, contentPath$);
    const modifiedFiles = (
      await git.statusMatrix({
        fs,
        dir: workingPath,
        filepaths: [contentPath$],
      })
    )
      .filter((result) => {
        const head = result[StatusEnum.HEAD];
        const workDir = result[StatusEnum.WORKDIR];
        const staged = result[StatusEnum.STAGE];
        // ignore unmodified files.
        return !(head === 1 && workDir === 1 && staged === 1);
      })
      .map((result) => result[StatusEnum.FILE]);
    if (!modifiedFiles.length) {
      console.log('No changes to commit.');
      return;
    }
    console.log('Modified files: ', modifiedFiles);

    // commit changes.
    try {
      await git.add({
        fs,
        dir: workingPath,
        filepath: modifiedFiles,
      });
      const sha = await git.commit({
        fs,
        dir: workingPath,
        author: {
          name: authorName,
          email: authorEmail,
        },
        message: commitMessage,
      });
      console.log('Committed modified files: ', sha, modifiedFiles);
    } catch (error) {
      console.log('Failed to commit modified files: ', error, modifiedFiles);
      throw new Error(error);
    }

    // push changes.
    try {
      await git.push({
        fs,
        http,
        dir: workingPath,
        remote: 'origin',
        url: gitUrl,
        ref: contentPublishBranch,
        onAuth: () => ({
          username: gitUsername,
          password: gitPassword,
        }),
      });
      console.log('Pushed changes to remote.', contentPublishBranch);
    } catch (error) {
      console.log('Failed to push changes: ', error);
      throw new Error(error);
    }

    // Create pull request.
    // https://docs.github.com/en/rest/pulls/pulls?apiVersion=2022-11-28#create-a-pull-request
    // response type: node_modules/axios/index.d.ts
    console.log('Creating pull request...', `https://api.github.com/repos/${owner}/${repo}/pulls`);
    
    const { data: {
      number: pullNumber,
    }} = await axios.post<any, AxiosResponse<any, any>, any>(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
      owner,
      repo,
      title: 'chore(content): publish updates',
      body: '',
      head: contentPublishBranch,
      base,
      baseURL: 'https://api.github.com/',
      headers: {
        'Authorization': `Bearer ${gitPassword}`,
        'Content-Type': 'application/json',
        'Accept': 'application/vnd.github+json',
      }
    });

    if (!pullNumber) {
      throw new Error('Failed to retrieve content publish PR number.');
    }

    await axios.put<any, AxiosResponse<any, any>, any>(`https://api.github.com/repos/${owner}/${repo}/pulls/${pullNumber}/merge`, {
      owner,
      repo,
      baseURL: 'https://api.github.com/',
      pull_number: pullNumber,
      commit_title: `Merge pull request ${pullNumber}`,
      commit_message: 'Publish content',
      headers: {
        'Authorization': `Bearer ${gitPassword}`,
        'Content-Type': 'application/json',
        'Accept': 'application/vnd.github+json',
      }
    })
  } catch (error) {
    console.log('Failed to create content publish PR: ', error);
  }
};

const start = async () => {
  try {
    const {
      base, script, message, path
    } = yargs(process.argv.slice(2))
      .usage('Usage: $0 <command> [options]')
      .options({
        base: { type: 'string', default: '', alias: 'b' },
        script: { type: 'string', default: 'echo', alias: 's' },
        message: { type: 'string', default: 'Product publish', alias: 'm' },
        path: { type: 'string', default: 'src', alias: 'p' },
      })
      .parseSync();
    const { username, password } = getGitCredentials();
    const tempPath = await getTempPath();
    const gitRoot = await git.findRoot({
      fs,
      filepath: process.cwd(),
    });
    const remotes = await git.listRemotes({ fs, dir: gitRoot });
    const origin = remotes.find((r) => r.remote === 'origin');

    if (!origin) {
      throw new Error('No remote origin found.');
    }
    const { url } = origin;

    const base$ = base || process.env.CONTENT_PUBLISH_BASE_BRANCH || DEFAULT_BASE_BRANCH;

    const props = {
      base: base$,
      script,
      message,
      path,
      gitUrl: getGitWebUrl(url),
      gitUsername: username,
      gitPassword: password,
      tempPath,
    };
    if (await validateInput(props)) {
      contentCommit(props);
    }
  } catch (error) {
    console.error(error);
  }
};

start();
