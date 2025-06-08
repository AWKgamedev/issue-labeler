const core = require('@actions/core');
const github = require('@actions/github');
const { Octokit } = require('@octokit/rest');
const { GoogleGenerativeAI } = require('@google/generative-ai');

async function run() {
    try {
        const githubToken = core.getInput('github-token');
        const aiApiKey = core.getInput('ai-api-key');

        const octokit = new Octokit({ auth: githubToken });

        const payload = github.context.payload;
        const issue = payload.issue;
        const repository = payload.repository;

        if (!issue) {
            core.info('No issue found in the payload. Exiting.');
            return;
        }

        const issueTitle = issue.title;
        const issueBody = issue.body || 'No description provided.';
        const issueNumber = issue.number;
        const owner = repository.owner.login;
        const repo = repository.name;

        core.info(`Processing issue #${issueNumber}: ${issueTitle}`);

        // 1. Get all project labels and their descriptions
        const { data: repoLabels } = await octokit.rest.issues.listLabelsForRepo({
            owner,
            repo,
        });

        let labelsPrompt = 'Existing labels in the project:\n';
        if (repoLabels.length > 0) {
            repoLabels.forEach(label => {
                labelsPrompt += `- Name: "${label.name}", Description: "${label.description || 'No description'}"\n`;
            });
        } else {
            labelsPrompt += 'No existing labels.\n';
        }

        // 2. Construct the prompt for the AI model
        const prompt = `You are an expert GitHub issue labeler. Your task is to analyze an issue and suggest appropriate labels from a given list. If no existing labels seem suitable, suggest new, highly relevant labels.

Here is the issue:
Title: "${issueTitle}"
Body: "${issueBody}"

${labelsPrompt}

Instructions:
- Based on the issue's title and body, suggest up to 3 existing labels that are most relevant.
- If existing labels are not sufficient, suggest up to 2 new, concise, and descriptive labels.
- Provide your response in a JSON array format. Each element in the array should be an object with a 'name' property for the label. If it's a new label, also include a 'description' property.
- Example format:
  [
    { "name": "bug" },
    { "name": "enhancement" },
    { "name": "feature", "description": "New features or functionalities" }
  ]
`;

        core.info('Sending prompt to AI model...');

        // Initialize AI model
        const genAI = new GoogleGenerativeAI(aiApiKey);
        const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" }); // Or "gemini-1.5-flash", "gemini-1.5-pro", etc.

        const result = await model.generateContent(prompt);
        const response = result.response;
        const text = response.text();

        core.info(`AI Response: ${text}`);

        let suggestedLabels = [];
        try {
            // Attempt to parse the JSON output from the AI
            suggestedLabels = JSON.parse(text);
            if (!Array.isArray(suggestedLabels)) {
                throw new Error("AI response was not a JSON array.");
            }
        } catch (parseError) {
            core.error(`Failed to parse AI response as JSON: ${parseError.message}`);
            // Fallback: Try to extract labels if JSON parsing fails (less robust)
            const matches = text.match(/"name":\s*"([^"]+)"/g);
            if (matches) {
                suggestedLabels = matches.map(m => ({ name: m.match(/"name":\s*"([^"]+)"/)[1] }));
                core.warning('Attempted to extract labels using regex due to JSON parsing error. This might not be accurate.');
            } else {
                core.warning('Could not extract any labels from AI response.');
                return; // Exit if no labels can be extracted
            }
        }

        const labelsToAdd = [];
        for (const labelData of suggestedLabels) {
            const labelName = labelData.name;
            const labelDescription = labelData.description;

            const existingLabel = repoLabels.find(l => l.name.toLowerCase() === labelName.toLowerCase());

            if (!existingLabel) {
                core.info(`Label "${labelName}" does not exist. Creating it.`);
                try {
                    await octokit.rest.issues.createLabel({
                        owner,
                        repo,
                        name: labelName,
                        color: 'ededed', // Default color, you might want to randomize or define
                        description: labelDescription || `Label suggested by AI for ${labelName}`
                    });
                    labelsToAdd.push(labelName);
                    core.info(`Created label "${labelName}".`);
                } catch (createError) {
                    core.error(`Failed to create label "${labelName}": ${createError.message}`);
                    // If label creation fails (e.g., already exists due to race condition),
                    // we can still try to add it to the issue if it now exists.
                    const { data: updatedRepoLabels } = await octokit.rest.issues.listLabelsForRepo({ owner, repo });
                    if (updatedRepoLabels.find(l => l.name.toLowerCase() === labelName.toLowerCase())) {
                        labelsToAdd.push(labelName);
                    }
                }
            } else {
                core.info(`Label "${labelName}" already exists.`);
                labelsToAdd.push(labelName);
            }
        }

        if (labelsToAdd.length > 0) {
            core.info(`Adding labels to issue #${issueNumber}: ${labelsToAdd.join(', ')}`);
            await octokit.rest.issues.addLabels({
                owner,
                repo,
                issue_number: issueNumber,
                labels: labelsToAdd,
            });
            core.info(`Labels successfully added to issue #${issueNumber}.`);
            core.setOutput('labels-applied', labelsToAdd.join(','));
        } else {
            core.info('No labels to add to the issue.');
            core.setOutput('labels-applied', '');
        }

    } catch (error) {
        core.setFailed(`Action failed with error: ${error.message}`);
    }
}

run();