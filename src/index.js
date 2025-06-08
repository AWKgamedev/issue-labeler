const core = require('@actions/core');
const github = require('@actions/github');
const { Octokit } = require('@octokit/rest');
// Import Type from the SDK
const { GoogleGenerativeAI, Part, FunctionCalling, GenerativeModel, type, constants } = require('@google/generative-ai');


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
        // The prompt now focuses solely on the content, as the output format is handled by the schema.
        const prompt = `You are an expert GitHub issue labeler. Your task is to analyze an issue and suggest appropriate labels from a given list. If no existing labels seem suitable, suggest new, highly relevant labels.

Here is the issue:
Title: "${issueTitle}"
Body: "${issueBody}"

${labelsPrompt}

Instructions:
- Based on the issue's title and body, suggest up to 3 existing labels that are most relevant.
- If existing labels are not sufficient, suggest up to 2 new, concise, and descriptive labels.
- For new labels, ensure a good description is provided.
`;

        core.info('Sending prompt to AI model with structured output...');

        // Initialize AI model
        const genAI = new GoogleGenerativeAI(aiApiKey);
        const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" }); // Or "gemini-1.5-pro"

        // *** IMPORTANT CHANGE HERE ***
        // Use the generateContent method directly with the config for structured output
        const result = await model.generateContent({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: {
                responseMimeType: "application/json",
                responseSchema: {
                    type: type.Type.ARRAY,
                    items: {
                        type: type.Type.OBJECT,
                        properties: {
                            name: { // Label name
                                type: type.Type.STRING,
                            },
                            description: { // Description for new labels
                                type: type.Type.STRING,
                                description: "Required only if this is a new label suggestion. A concise description of the label's purpose.",
                            },
                        },
                        // The AI might return properties in any order, so propertyOrdering is less critical here
                        // but can be included if you have a strong preference for the order within each object.
                        // propertyOrdering: ["name", "description"],
                        required: ["name"], // 'name' is always required
                    },
                },
            },
        });

        // The response text for structured output will already be valid JSON
        const text = result.response.text();
        core.info(`AI Structured Response: ${text}`);

        let suggestedLabels = [];
        try {
            suggestedLabels = JSON.parse(text);
            if (!Array.isArray(suggestedLabels)) {
                throw new Error("AI response was not a JSON array, despite schema.");
            }
        } catch (parseError) {
            core.setFailed(`Failed to parse AI response as JSON even with structured output config: ${parseError.message}. Raw AI response: ${text}`);
            return; // Exit if parsing fails
        }

        const labelsToAdd = [];
        for (const labelData of suggestedLabels) {
            const labelName = labelData.name;
            // Provide a default description for new labels if the AI doesn't provide one,
            // though with the schema, it should be prompted to.
            const labelDescription = labelData.description || `AI-suggested label for ${labelName}`;


            const existingLabel = repoLabels.find(l => l.name.toLowerCase() === labelName.toLowerCase());

            if (!existingLabel) {
                core.info(`Label "${labelName}" does not exist. Creating it.`);
                try {
                    await octokit.rest.issues.createLabel({
                        owner,
                        repo,
                        name: labelName,
                        color: 'ededed', // Default color
                        description: labelDescription
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